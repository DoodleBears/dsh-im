import { createHash } from 'node:crypto';
import { qqNativeIdentifier } from './native-reply-observations.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const evidence = value => qqNativeIdentifier(value) ? { hash: hash(value), length: value.length } : undefined;
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(names.flatMap(name => {
    const item = evidence(Object.getOwnPropertyDescriptor(value, name)?.value);
    return item ? [[name, item]] : [];
  })) : {};

/** Metadata from the pinned SDK's public pre-dispatch Logger; never intake or Echo authority. */
export class QqNativeGatewayDiagnostics {
  #prefix;
  #fingerprint;
  #report;
  #seen = new Map();
  #windowAt = 0;
  #reported = 0;
  #suppressed = 0;
  constructor({ botId, account, report }) {
    this.#prefix = `[${botId}] Dispatch event: t=`;
    this.#fingerprint = account.fingerprint;
    this.#report = report;
  }
  observe(message, signal) {
    if (signal?.aborted || typeof this.#report !== 'function' || typeof message !== 'string'
      || !message.startsWith(this.#prefix)) return;
    const now = Date.now();
    if (now - this.#windowAt >= 60_000) { this.#windowAt = now; this.#reported = 0; }
    if (this.#reported >= 64) { this.#suppressed++; return; }
    this.#reported++;
    const emit = record => {
      try {
        this.#report(Object.freeze({ ...record, accountFingerprint: this.#fingerprint, suppressed: this.#suppressed }));
        this.#suppressed = 0;
      } catch {}
    };
    const refuse = reason => emit({ event: 'qq.native-gateway.refusal', reason });
    if (message.length > 262_144 || Buffer.byteLength(message, 'utf8') > 262_144) { refuse('oversized'); return; }
    const separator = message.indexOf(' payload=', this.#prefix.length);
    if (separator < 0) { refuse('format'); return; }
    const type = message.slice(this.#prefix.length, separator);
    if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(type)) { refuse('format'); return; }
    if (type === 'READY' || type === 'RESUMED') {
      emit({ event: 'qq.native-gateway.lifecycle', phase: type === 'READY' ? 'ready' : 'resumed' });
      return;
    }
    let raw;
    try { raw = JSON.parse(message.slice(separator + 9)); }
    catch { refuse('malformed'); return; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !qqNativeIdentifier(raw.group_openid) || !qqNativeIdentifier(raw.id)) {
      refuse(['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(type) ? 'invalid-group-frame' : 'non-group');
      return;
    }
    for (const [key, at] of this.#seen) if (now - at > 300_000) this.#seen.delete(key);
    const key = JSON.stringify([type, raw.group_openid, raw.id]);
    if (this.#seen.has(key)) return;
    this.#seen.set(key, now);
    while (this.#seen.size > 128) this.#seen.delete(this.#seen.keys().next().value);
    const flag = raw.author?.bot;
    const indexes = Array.isArray(raw.message_scene?.ext) ? raw.message_scene.ext.slice(0, 64) : [];
    const index = indexes.find(value => typeof value === 'string' && value.startsWith('msg_idx='));
    emit({ event: 'qq.native-gateway.frame',
      eventType: ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(type) ? type : 'other',
      conversationHash: hash(raw.group_openid), messageHash: hash(raw.id),
      senderBotFlag: flag === true ? 'true' : flag === false ? 'false' : flag === undefined ? 'absent' : 'other',
      authorIdentifiers: fields(raw.author, ['member_openid', 'id', 'user_openid', 'union_openid', 'openid']),
      messageIdentifiers: fields(raw, ['id', 'message_id', 'msg_id', 'msg_idx']),
      messageIndexIdentifier: evidence(index?.slice(8)),
      indexEvidenceTruncated: Array.isArray(raw.message_scene?.ext) && raw.message_scene.ext.length > 64,
      mentionIdentifiers: Array.isArray(raw.mentions) ? raw.mentions.slice(0, 8).map(mention => ({
        self: mention?.is_you === true,
        selfFlag: mention?.is_you === true ? 'true' : mention?.is_you === false ? 'false'
          : mention?.is_you === undefined ? 'absent' : 'other',
        identifiers: fields(mention, ['id', 'user_openid', 'member_openid']),
      })) : [],
      mentionsTruncated: Array.isArray(raw.mentions) && raw.mentions.length > 8,
    });
  }
}
