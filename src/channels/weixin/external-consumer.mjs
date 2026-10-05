import { createHash } from 'node:crypto';
import { deriveWeixinBotIdentity, maskWeixinAccountId } from './config-store.mjs';
import { extractWeixinText, weixinMessageId } from './weixin-api.mjs';

export function weixinRefusal(code) { return Object.assign(new Error(code), { code }); }
const continuation = value => typeof value === 'string' && value.length > 0 && value.length <= 16384;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;

/** Identity comes from the stored server-confirmed QR pairing, not a fabricated auth.test API.
 * A different credential invalidates all grants even if its local reference is unchanged. */
export function pairedWeixinAccount(config, token) {
  if (!id(config?.accountId) || !id(config?.ownerUserId) || !config.connectedAt || typeof token !== 'string' || !token.trim()
    || deriveWeixinBotIdentity(config.accountId).botId !== config.botId) throw weixinRefusal('account-unverified');
  const credentialHash = createHash('sha256').update(token).digest('hex');
  const identity = { provider: 'weixin', accountId: config.accountId, ownerUserId: config.ownerUserId,
    baseUrl: config.baseUrl, credentialHash };
  return Object.freeze({ accountId: config.accountId, ownerUserId: config.ownerUserId,
    name: `微信 · ${maskWeixinAccountId(config.accountId)}`,
    fingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex') });
}

/** Paired-owner text and opt-in native files/images. No group, mention, or thread is invented. */
export function normalizeWeixinExternalText(message, { botId, account, sourceFiles = false, sourceImages = false }) {
  if (message?.message_type !== 1 || message.from_user_id !== account.ownerUserId || message.group_id) return null;
  if (message.to_user_id !== account.accountId) throw weixinRefusal('account-changed');
  if (!Array.isArray(message.item_list) || !message.item_list.length
    || message.item_list.some(item => item?.type !== 1 && !(sourceFiles && item?.type === 4) && !(sourceImages && item?.type === 2))) return null;
  const messageId = weixinMessageId(message);
  const files = message.item_list.filter(item => item?.type === 4 || item?.type === 2);
  const image = files[0]?.type === 2 ? files[0].image_item : undefined;
  if (files[0]?.type === 2 && (!image || typeof image !== 'object')) throw weixinRefusal('resource-unavailable');
  if (files.length > 1) throw weixinRefusal('resource-unavailable');
  const nativeFile = image ? { file_name: 'image', image: true } : files[0]?.file_item;
  if (files.length && (!nativeFile || !id(nativeFile.file_name)
    || /[\x00-\x1f\x7f/\\]/.test(nativeFile.file_name))) throw weixinRefusal('resource-unavailable');
  const text = extractWeixinText(message) || (nativeFile ? (image ? '[Image]' : `[File: ${nativeFile.file_name}]`) : '');
  const time = typeof message.create_time_ms === 'string' ? Number(message.create_time_ms) : message.create_time_ms;
  if (!messageId || !/^\d+$/.test(messageId) || !text?.trim() || text.length > 16000
    || !Number.isSafeInteger(time) || time <= 0 || !continuation(message.context_token)) throw weixinRefusal('invalid-inbound');
  const at = new Date(time);
  if (!Number.isFinite(at.getTime())) throw weixinRefusal('invalid-inbound');
  const conversationId = account.ownerUserId;
  const resourceKey = nativeFile ? createHash('sha256').update(JSON.stringify([
    account.fingerprint, conversationId, messageId, nativeFile.file_name, nativeFile.len ?? null, ...(image ? ['image'] : []),
  ])).digest('hex') : undefined;
  const size = nativeFile?.len === undefined ? undefined : Number(nativeFile.len);
  if (nativeFile?.len !== undefined && (!/^\d+$/.test(String(nativeFile.len))
    || !Number.isSafeInteger(size) || size < 0)) throw weixinRefusal('resource-unavailable');
  const attachments = nativeFile ? Object.freeze([Object.freeze({
    id: createHash('sha256').update(JSON.stringify([account.fingerprint, conversationId, messageId, resourceKey])).digest('hex'),
    messageId, resourceKey, name: nativeFile.file_name,
    ...(size > 0 ? { sizeBytes: size } : {}), mediaType: image ? 'image/unknown' : 'application/octet-stream',
  })]) : undefined;
  return Object.freeze({ version: 1, channel: 'weixin', botId, fingerprint: account.fingerprint,
    eventId: messageId, messageId, actor: Object.freeze({ kind: 'user', id: account.ownerUserId }),
    conversation: Object.freeze({ kind: 'dm', id: conversationId }), mentions: Object.freeze([]),
    mentionedAccount: false, at: at.toISOString(), text, ...(attachments ? { attachments } : {}),
    reply: Object.freeze({ messageId, conversationId, actorId: account.ownerUserId }),
    replay: Object.freeze({ kind: 'provider-redelivery', resumeCursor: false, gapPossible: true }) });
}

export function checkedWeixinRoute(route, account, source) {
  if (!route || Object.keys(route).some(key => !['messageId', 'conversationId', 'actorId'].includes(key))
    || route.conversationId !== account.ownerUserId || route.actorId !== account.ownerUserId
    || !id(route.messageId) || !source || source.fingerprint !== account.fingerprint
    || source.actorId !== route.actorId || source.messageId !== route.messageId
    || source.expiresAt <= Date.now() || !continuation(source.contextToken)) throw weixinRefusal('stale-route');
  return { messageId: route.messageId, conversationId: route.conversationId, actorId: route.actorId };
}
