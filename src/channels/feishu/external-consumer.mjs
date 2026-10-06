import { nativeFileContent } from './external-files.mjs';
import { nativeImageContent } from './external-images.mjs';
function refusal(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

export function normalizeExternalText(event, { botId, appId, botOpenId, fingerprint }) {
  const message = event?.message;
  const actorId = identifier(event?.sender?.sender_id?.open_id);
  const messageId = identifier(message?.message_id);
  const conversationId = identifier(message?.chat_id);
  const eventId = identifier(event?.event_id ?? event?.header?.event_id);
  const eventApp = event?.app_id ?? event?.header?.app_id;
  if (eventApp !== undefined && eventApp !== appId) throw refusal('account-changed');
  if (event?.sender?.sender_type === 'app' || event?.sender?.sender_type === 'bot') return null;
  if (event?.sender?.sender_type !== 'user'
    || !['p2p', 'group'].includes(message?.chat_type) || message?.message_type !== 'text') return null;
  if (message.chat_type === 'group' && !identifier(botOpenId)) throw refusal('account-unverified');
  if (message.mentions !== undefined && (!Array.isArray(message.mentions) || message.mentions.length > 100))
    throw refusal('invalid-inbound');
  const mentions = Object.freeze((message.mentions ?? []).map(mention => {
    const id = identifier(mention?.id?.open_id ?? mention?.open_id);
    const key = identifier(mention?.key);
    if (!id || !key) throw refusal('invalid-inbound');
    const name = identifier(mention?.name);
    return Object.freeze({ id, key, ...(name ? { name } : {}) });
  }));
  if (!actorId || !messageId || !conversationId || !eventId
    || !/^[a-f0-9]{64}$/.test(fingerprint ?? '')) throw refusal('invalid-inbound');
  let text;
  try { text = JSON.parse(message.content)?.text; } catch { throw refusal('invalid-inbound'); }
  if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw refusal('invalid-inbound');
  const milliseconds = Number(message.create_time);
  const timestamp = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || !Number.isFinite(timestamp.getTime()))
    throw refusal('invalid-inbound');
  const route = Object.freeze({
    messageId, conversationId, actorId,
    ...(identifier(message.thread_id) ? { threadId: message.thread_id } : {}),
    ...(identifier(message.root_id) ? { rootId: message.root_id } : {}),
    ...(identifier(message.parent_id) ? { parentId: message.parent_id } : {}),
  });
  return Object.freeze({
    version: 1, channel: 'feishu', botId, fingerprint, eventId, messageId,
    actor: Object.freeze({ kind: 'user', id: actorId,
      ...(identifier(event.sender.sender_name) ? { name: event.sender.sender_name } : {}) }),
    conversation: Object.freeze({ kind: message.chat_type === 'group' ? 'group' : 'dm', id: conversationId }),
    mentions, mentionedAccount: mentions.some(mention => mention.id === botOpenId),
    at: timestamp.toISOString(), text, reply: route,
    replay: Object.freeze({ kind: 'provider-redelivery', resumeCursor: false, gapPossible: true }),
  });
}

export function normalizeExternalMedia(event, identity) {
  const message = event?.message;
  if (!['image', 'post', 'file'].includes(message?.message_type)) return normalizeExternalText(event, identity);
  if (event?.sender?.sender_type !== 'user') return null;
  const media = nativeImageContent(message, message.chat_id) ?? nativeFileContent(message, message.chat_id);
  if (!media) return null;
  const base = normalizeExternalText({ ...event, message: { ...message, message_type: 'text', content: JSON.stringify({ text: media.text }) } }, identity);
  if (!base) return null;
  return Object.freeze({ ...base, attachments: Object.freeze(media.attachments.map(Object.freeze)), ...(media.contentParts ? { contentParts: Object.freeze(media.contentParts.map(Object.freeze)) } : {}) });
}

export function normalizeOwnTextEcho(event, { botId, appId, botOpenId, fingerprint }) {
  if (!['app', 'bot'].includes(event?.sender?.sender_type)) return null;
  if (event?.sender?.sender_id?.open_id !== botOpenId && event?.sender?.sender_id?.app_id !== appId) return null;
  const message = event?.message;
  if (message?.chat_type !== 'group' || message?.message_type !== 'text') return null;
  const eventApp = event?.app_id ?? event?.header?.app_id;
  if (eventApp !== undefined && eventApp !== appId) throw refusal('account-changed');
  let text;
  try { text = JSON.parse(message.content)?.text; } catch { throw refusal('invalid-inbound'); }
  const eventId = identifier(event?.event_id ?? event?.header?.event_id);
  const messageId = identifier(message.message_id);
  const conversationId = identifier(message.chat_id);
  const at = new Date(Number(message.create_time));
  if (!eventId || !messageId || !conversationId || typeof text !== 'string' || !text.trim()
    || text.length > 16000 || !Number.isFinite(at.getTime()) || !/^[a-f0-9]{64}$/.test(fingerprint ?? ''))
    throw refusal('invalid-inbound');
  return Object.freeze({ version: 1, botId, fingerprint, eventId, messageId, conversationId, text, at: at.toISOString() });
}

export { ExclusiveInboundConsumers } from '../shared/exclusive-inbound-consumers.mjs';
