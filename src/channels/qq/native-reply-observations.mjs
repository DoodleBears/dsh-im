import { createHash } from 'node:crypto';

export function qqNativeIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.trim() === value && !/[\s\u0000-\u001f]/u.test(value);
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function identifierEvidence(value) {
  return qqNativeIdentifier(value) ? { hash: hash(value), length: value.length } : undefined;
}

function identifierFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(fields.flatMap(field => {
    const evidence = identifierEvidence(Object.getOwnPropertyDescriptor(value, field)?.value);
    return evidence ? [[field, evidence]] : [];
  }));
}

const AUTHOR_IDENTIFIERS = ['member_openid', 'id', 'user_openid', 'union_openid', 'openid'];
const MESSAGE_IDENTIFIERS = ['id', 'message_id', 'msg_id', 'msg_idx'];

export class QqNativeReplyObservations {
  #account;
  #report;
  #entries = new Map();
  #windowAt = 0;
  #reported = 0;
  #suppressed = 0;
  #reportFrame;
  #nativeUserIdentifiers = {};
  #frameSeen = new Map();
  #frameWindowAt = 0;
  #framesReported = 0;
  #framesSuppressed = 0;
  constructor({ account, report, reportFrame, nativeUser }) {
    this.#account = account;
    this.#report = report;
    this.#reportFrame = reportFrame;
    if (typeof reportFrame === 'function') {
      try { this.#nativeUserIdentifiers = identifierFields(nativeUser ?? { id: account.userId }, AUTHOR_IDENTIFIERS); }
      catch {}
    }
  }
  // Process evidence only. Unknown authors never enter the candidate/receipt cache.
  #frame(phase, conversationId, messageId, metadata = () => ({})) {
    if (typeof this.#reportFrame !== 'function') return;
    const now = Date.now();
    for (const [key, at] of this.#frameSeen)
      if (now - at > 300_000) this.#frameSeen.delete(key);
    const key = JSON.stringify([phase, conversationId, messageId]);
    if (this.#frameSeen.has(key)) return;
    this.#frameSeen.set(key, now);
    while (this.#frameSeen.size > 128) this.#frameSeen.delete(this.#frameSeen.keys().next().value);
    if (now - this.#frameWindowAt >= 60_000) {
      this.#frameWindowAt = now;
      this.#framesReported = 0;
    }
    if (this.#framesReported >= 64) { this.#framesSuppressed++; return; }
    this.#framesReported++;
    try {
      const record = Object.freeze({ event: 'qq.native-reply.frame', phase,
        accountFingerprint: this.#account.fingerprint,
        authenticatedUser: identifierEvidence(this.#account.userId),
        authenticatedUserIdentifiers: this.#nativeUserIdentifiers,
        conversationHash: hash(conversationId), messageHash: hash(messageId),
        ...metadata(), suppressed: this.#framesSuppressed });
      this.#framesSuppressed = 0;
      this.#reportFrame(record);
    } catch {}
  }
  #entry(conversationId, messageId) {
    const now = Date.now();
    for (const [key, entry] of this.#entries)
      if (now - entry.at > 300_000) this.#entries.delete(key);
    const key = JSON.stringify([conversationId, messageId]);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { at: now, conversationHash: hash(conversationId), messageHash: hash(messageId),
        receipt: false, native: undefined };
      this.#entries.set(key, entry);
    }
    while (this.#entries.size > 128) this.#entries.delete(this.#entries.keys().next().value);
    return entry;
  }
  #emit(entry) {
    const now = Date.now();
    if (now - this.#windowAt >= 60_000) {
      this.#windowAt = now;
      this.#reported = 0;
    }
    if (this.#reported >= 64) { this.#suppressed++; return; }
    this.#reported++;
    const record = Object.freeze({
      event: 'qq.native-reply.observation', accountFingerprint: this.#account.fingerprint,
      conversationHash: entry.conversationHash, messageHash: entry.messageHash,
      ...entry.native, receiptMatched: entry.receipt, suppressed: this.#suppressed,
    });
    this.#suppressed = 0;
    try { this.#report(record); } catch {}
  }
  receive(message, signal) {
    if (signal?.aborted || message?.kind !== 'group'
      || !['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(message.rawEventType)
      || !qqNativeIdentifier(message.messageId) || !qqNativeIdentifier(message.groupOpenid)) return;
    this.#frame('callback', message.groupOpenid, message.messageId, () => ({
      eventType: message.rawEventType,
      senderBotFlag: message.senderIsBot === true ? 'true' : message.senderIsBot === false ? 'false'
        : message.senderIsBot === undefined ? 'absent' : 'other',
      senderMatchesAuthenticatedBot: message.senderId === this.#account.userId,
      senderIdentifier: identifierEvidence(message.senderId),
      authorIdentifiers: identifierFields(message.raw?.author, AUTHOR_IDENTIFIERS),
      messageIdentifiers: identifierFields(message.raw, MESSAGE_IDENTIFIERS),
      messageIndexIdentifier: identifierEvidence(message.msgIdx),
      mentionIdentifiers: Array.isArray(message.mentions) ? message.mentions.slice(0, 8).map(mention => ({
        self: mention?.is_you === true,
        selfFlag: mention?.is_you === true ? 'true' : mention?.is_you === false ? 'false'
          : mention?.is_you === undefined ? 'absent' : 'other',
        identifiers: identifierFields(mention, ['id', 'user_openid', 'member_openid']),
      })) : [],
      mentionsTruncated: Array.isArray(message.mentions) && message.mentions.length > 8,
    }));
    if (!(message.senderIsBot === true || message.senderId === this.#account.userId)) return;
    const entry = this.#entry(message.groupOpenid, message.messageId);
    if (entry.native) return;
    entry.native = { eventType: message.rawEventType, senderIsBot: message.senderIsBot === true,
      senderMatchesAuthenticatedBot: message.senderId === this.#account.userId };
    this.#emit(entry);
  }
  sent(conversationId, messageId, signal, nativeResponse) {
    if (signal?.aborted || !qqNativeIdentifier(conversationId) || !qqNativeIdentifier(messageId)) return;
    this.#frame('receipt', conversationId, messageId, () => ({
      messageIdentifiers: identifierFields(nativeResponse ?? { id: messageId }, MESSAGE_IDENTIFIERS),
      messageIndexIdentifier: identifierEvidence(nativeResponse?.ext_info?.ref_idx),
    }));
    const entry = this.#entry(conversationId, messageId);
    if (entry.receipt) return;
    entry.receipt = true;
    if (entry.native) this.#emit(entry);
  }
}
