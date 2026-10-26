import { isQqAddressedGroupMessage } from './external-addressing.mjs';
import { createHash } from 'node:crypto';
import { ApiError, getNextMsgSeq, messagePath } from '@tencent-connect/qqbot-nodejs/protocol';
import { QqNativeReplyObservations, qqNativeIdentifier as identifier } from './native-reply-observations.mjs';
import { qqSourceAttachments, readQqSourceAttachment, checkedQqImageFile, uploadQqCheckedMedia } from './external-images.mjs';
import { checkedQqGenericFile, qqQuoteHasAttachments, qqQuotedFileMessage, qqQuotedTextMessage } from './external-files.mjs';
import { qqVoiceMessage } from './external-voice.mjs';
import { qqExternalMentions } from './external-mentions.mjs';

export function qqRefusal(code) { return Object.assign(new Error(code), { code }); }

// QQ rejects a rate-limited post outright, so the same msg_seq is retried
// after a short backoff; any other outcome is returned to the caller as is.
const RATE_LIMIT_RETRY_DELAYS_MS = Object.freeze([1_000, 3_000]);
const POST_QUEUE_WAIT_MS = 30_000;

function retryDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(qqRefusal('cancelled')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    timer.unref?.();
    const abort = () => { clearTimeout(timer); reject(qqRefusal('cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function nativeReplyFailure(error) {
  if (!(error instanceof ApiError)) return qqRefusal('reply-result-unknown');
  const code = Number(error.bizCode);
  if ([304103, 40034005].includes(code)) return qqRefusal('reply-window-expired');
  if (code === 40034128) return qqRefusal('reply-limit-exceeded');
  if (error.httpStatus === 429 || code === 40034100) return qqRefusal('reply-rate-limited');
  if ([40034101, 40034105, 40054002, 40054003, 40054016].includes(code))
    return qqRefusal('reply-permission-denied');
  if ([22006, 304061, 40034006, 40054007, 40054010].includes(code)) return qqRefusal('bad-request');
  if (code === 40034024) return qqRefusal('stale-route');
  return qqRefusal('reply-result-unknown');
}

export function verifiedQqAccount(appId, user) {
  // Authenticated GET /users/@me identifies the current robot. Live group apps
  // can omit the example's bot flag; an explicit contradictory flag still fails.
  const robot = user && (user.bot === true || !Object.hasOwn(user, 'bot'));
  if (!identifier(appId) || !identifier(user?.id) || !robot) {
    const error = qqRefusal('account-unverified');
    error.verificationFailure = !identifier(appId) ? 'application-id'
      : !identifier(user?.id) ? 'native-user-id' : 'native-bot-flag';
    throw error;
  }
  const identity = { provider: 'qq', appId, userId: user.id };
  return Object.freeze({ appId, userId: user.id,
    fingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    ...(typeof user.username === 'string' && user.username.trim()
      ? { name: user.username.slice(0, 512) } : {}),
  });
}

/** QQ group and member OpenIDs belong to this authenticated application. */
export function normalizeQqExternalText(message, { botId, account, ordinaryText = false }) {
  const addressed = isQqAddressedGroupMessage(message);
  const ordinary = ordinaryText === true && message?.kind === 'group'
    && message.rawEventType === 'GROUP_MESSAGE_CREATE';
  if (!(addressed || ordinary)
    || message.senderIsBot || message.senderId === account.userId
    || message.attachments?.length || message.msgElements?.length
    || (message.msgType !== undefined && message.msgType !== 0)) return null;
  if (!identifier(message.messageId) || !identifier(message.senderId)
    || !identifier(message.groupOpenid) || typeof message.content !== 'string'
    || !message.content.trim() || message.content.length > 16000
    || message.replyTarget?.scope !== 'group'
    || message.replyTarget.targetId !== message.groupOpenid
    || message.replyTarget.msgId !== message.messageId)
    throw qqRefusal('invalid-inbound');
  const at = new Date(message.timestamp);
  if (!Number.isFinite(at.getTime())) throw qqRefusal('invalid-inbound');
  return Object.freeze({ version: 1, channel: 'qq', botId, fingerprint: account.fingerprint,
    eventId: message.messageId, messageId: message.messageId,
    actor: { kind: 'user', id: message.senderId,
      ...(typeof message.senderName === 'string' && message.senderName.trim()
        ? { name: message.senderName.slice(0, 512) } : {}) },
    conversation: { kind: 'group', id: message.groupOpenid },
    mentions: qqExternalMentions(message, account), mentionedAccount: addressed, at: at.toISOString(), text: message.content,
    reply: { messageId: message.messageId, conversationId: message.groupOpenid, actorId: message.senderId },
    replay: { kind: 'provider-redelivery', resumeCursor: false, gapPossible: true },
  });
}

/** Bounded, process-local source proof, never a second durable Inbox or history. */
export class QqExternalConsumer {
  #bot;
  #account;
  #botId;
  #accept;
  #observations;
  #sourceImages;
  #sourceFiles;
  #sourceVoiceTranscripts;
  #sourceVoiceAudio;
  #ordinaryText;
  #rateLimitRetryDelaysMs;
  #sources = new Map();
  #posts = new Map();
  constructor({ bot, account, botId, accept, sourceImages = () => false, sourceFiles = () => false, sourceVoiceTranscripts = () => false, sourceVoiceAudio = () => false, ordinaryText = () => false, reportNativeObservation = () => {}, reportNativeFrame, nativeUser, rateLimitRetryDelaysMs = RATE_LIMIT_RETRY_DELAYS_MS }) {
    this.#rateLimitRetryDelaysMs = rateLimitRetryDelaysMs;
    this.#bot = bot; this.#account = account; this.#botId = botId; this.#accept = accept;
    this.#observations = new QqNativeReplyObservations({ account, report: reportNativeObservation,
      reportFrame: reportNativeFrame, nativeUser });
    this.#sourceImages = sourceImages;
    this.#sourceFiles = sourceFiles;
    this.#sourceVoiceTranscripts = sourceVoiceTranscripts;
    this.#sourceVoiceAudio = sourceVoiceAudio;
    this.#ordinaryText = ordinaryText;
  }
  recordNativeReceipt(receipt, signal) {
    this.#observations.sent(receipt.conversationId, receipt.messageId, signal);
  }
  async accept(message, signal) {
    this.#observations.receive(message, signal);
    const addressed = isQqAddressedGroupMessage(message);
    const voice = addressed && (this.#sourceVoiceTranscripts() === true || this.#sourceVoiceAudio() === true)
      ? qqVoiceMessage(message, { sourceVoiceTranscripts: this.#sourceVoiceTranscripts() === true }) : undefined;
    const quotedFiles = addressed && !voice && this.#sourceFiles() === true && qqQuoteHasAttachments(message);
    const quoted = !addressed || voice ? undefined
      : quotedFiles ? qqQuotedFileMessage(message) : qqQuotedTextMessage(message);
    message = quoted?.message ?? message;
    message = voice?.message ?? message;
    const mediaEnabled = addressed && (this.#sourceImages() === true || this.#sourceFiles() === true) && message?.attachments?.length;
    const base = normalizeQqExternalText(mediaEnabled ? { ...message, attachments: undefined,
      content: typeof message.content === 'string' && !message.content.trim()
        ? message.attachments.every(file => file?.content_type === 'file') ? '[File]' : '[Image]' : message.content } : message,
    { botId: this.#botId, account: this.#account, ordinaryText: this.#ordinaryText() === true });
    const media = base && voice && this.#sourceVoiceAudio() === true
      ? qqSourceAttachments(voice.nativeMessage, base, { sourceImages: false, sourceVoiceAudio: true, referenceKey: voice.referenceKey })
      : base && mediaEnabled ? qqSourceAttachments(message, base,
      { sourceImages: this.#sourceImages() === true, sourceFiles: this.#sourceFiles() === true,
        referenceKey: quoted?.referenceKey }) : undefined;
    const event = base && voice ? { ...(media?.event ?? base), voice: voice.voice } : media?.event ?? base;
    if (!event) return;
    signal.throwIfAborted();
    const prior = this.#sources.get(event.messageId);
    if (prior && JSON.stringify(prior.event) !== JSON.stringify(event)) throw qqRefusal('stale-route');
    // Consumer-owned objects never become the Provider's source authority.
    if (!prior) this.#sources.set(event.messageId, { event: structuredClone(event),
      ...(media ? { files: structuredClone(media.files) } : {}), attempts: 0 });
    while (this.#sources.size > 2000) this.#sources.delete(this.#sources.keys().next().value);
    // The external consumer acknowledges only after canonical ingestion commits.
    return this.#accept(event, signal);
  }
  #source(route, signal) {
    if (signal?.aborted) throw qqRefusal('cancelled');
    const source = this.#sources.get(route?.messageId);
    if (!source) throw qqRefusal('source-not-found');
    if (Object.keys(route).some(key => !['messageId', 'conversationId', 'actorId'].includes(key))
      || ['messageId', 'conversationId', 'actorId'].some(key => source.event.reply[key] !== route[key]))
      throw qqRefusal('stale-route');
    return source;
  }
  qualify(route, signal) {
    const source = this.#source(route, signal);
    if (!source.event.mentionedAccount) throw qqRefusal('capability-unavailable');
    if (Date.now() - Date.parse(source.event.at) >= 5 * 60_000) throw qqRefusal('reply-window-expired');
    if (source.attempts >= 5) throw qqRefusal('reply-limit-exceeded');
    return structuredClone(source.event.reply);
  }
  async readImage(route, attachment, options = {}) {
    const source = this.#source(route, options.signal);
    return readQqSourceAttachment(source, attachment, { ...options,
      assertCurrent: () => {
        if (this.#source(route, options.signal) !== source || this.#sourceImages() !== true)
          throw qqRefusal('source-unavailable');
      } });
  }
  async readFile(route, attachment, options = {}) {
    const source = this.#source(route, options.signal);
    return readQqSourceAttachment(source, attachment, { ...options,
      assertCurrent: () => {
        if (this.#source(route, options.signal) !== source || (source.event.voice ? this.#sourceVoiceAudio() !== true : this.#sourceFiles() !== true))
          throw qqRefusal('source-unavailable');
      } });
  }
  /** Posts to one group run one at a time; a rate-limited post backs off and retries. */
  #post(qualified, body, signal, assertSendable) {
    const conversationId = qualified.conversationId;
    const previous = this.#posts.get(conversationId) ?? Promise.resolve();
    const run = async () => {
      for (let retry = 0; ; retry++) {
        assertSendable();
        let token;
        try { token = await this.#bot.api.getToken(); }
        catch { throw qqRefusal('source-unavailable'); }
        assertSendable();
        this.#sources.get(qualified.messageId).attempts++;
        try {
          return await this.#bot.apiClient.request(token, 'POST', messagePath('group', conversationId), body);
        } catch (error) {
          const failure = nativeReplyFailure(error);
          if (failure.code !== 'reply-rate-limited' || retry >= this.#rateLimitRetryDelaysMs.length) throw failure;
          // A rate-limited post was refused, so it does not spend the passive reply budget.
          const source = this.#sources.get(qualified.messageId);
          if (source) source.attempts--;
          await retryDelay(this.#rateLimitRetryDelaysMs[retry], signal);
        }
      }
    };
    // A stalled earlier post must not hold the group's later replies past their window.
    const current = Promise.race([previous, retryDelay(POST_QUEUE_WAIT_MS).catch(() => undefined)])
      .catch(() => undefined).then(run);
    const tail = current.catch(() => undefined);
    this.#posts.set(conversationId, tail);
    tail.then(() => { if (this.#posts.get(conversationId) === tail) this.#posts.delete(conversationId); });
    return current;
  }
  async replyFile(route, file, { signal, beforeSend, verifyAccount } = {}) {
    const qualified = this.qualify(route, signal);
    if (typeof beforeSend !== 'function' || typeof verifyAccount !== 'function') throw qqRefusal('bad-request');
    const image = typeof file?.mediaType === 'string' && file.mediaType.startsWith('image/');
    const bytes = image ? checkedQqImageFile(file) : checkedQqGenericFile(file);
    if (beforeSend() !== true) throw qqRefusal('stale-route');
    if (signal?.aborted) throw qqRefusal('cancelled');
    const target = { scope: 'group', targetId: qualified.conversationId, msgId: qualified.messageId };
    const fileInfo = await uploadQqCheckedMedia(this.#bot, target, file, bytes, signal, image ? 1 : 4);
    await verifyAccount();
    const response = await this.#post(qualified,
      { msg_type: 7, media: { file_info: fileInfo }, msg_id: qualified.messageId,
        msg_seq: getNextMsgSeq(qualified.messageId) }, signal, () => {
        this.qualify(qualified, signal);
        if (beforeSend() !== true) throw qqRefusal('stale-route');
        if (signal?.aborted) throw qqRefusal('cancelled');
      });
    if (signal?.aborted || !identifier(response?.id)) throw qqRefusal('reply-result-unknown');
    this.#observations.sent(qualified.conversationId, response.id, signal, response);
    return { sent: true, receipt: { version: 1, messageId: response.id, conversationId: qualified.conversationId } };
  }
  async reply(route, text, { signal, receipt = false, beforeSend, mentionUserIds } = {}) {
    const qualified = this.qualify(route, signal);
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || mentionUserIds?.length)
      throw qqRefusal('bad-request');
    // The token is prepared before the fence so revocation and expiry are
    // checked immediately before the message POST, including on a retry.
    const response = await this.#post(qualified,
      { msg_type: 0, content: text, msg_id: qualified.messageId, msg_seq: getNextMsgSeq(qualified.messageId) },
      signal, () => {
        if (signal?.aborted) throw qqRefusal('cancelled');
        this.qualify(qualified, signal);
        if (beforeSend !== undefined && beforeSend() !== true) throw qqRefusal('stale-route');
        if (signal?.aborted) throw qqRefusal('cancelled');
      });
    // Once dispatch begins, cancellation or a missing response cannot prove non-delivery.
    if (signal?.aborted || !identifier(response?.id)) throw qqRefusal('reply-result-unknown');
    this.#observations.sent(qualified.conversationId, response.id, signal, response);
    return { sent: true, ...(receipt ? { receipt: { version: 1, messageId: response.id,
      conversationId: qualified.conversationId } } : { messageId: response.id }) };
  }
}
