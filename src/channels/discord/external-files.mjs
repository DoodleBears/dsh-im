import { createHash } from 'node:crypto';
import { discordRefusal, discordSnowflake, qualifyDiscordReply } from './external-consumer.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const MIME = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;
function safeName(value) {
  return typeof value === 'string' && value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f/\\]/.test(value);
}

function attachmentFor(source, route) {
  if (source.attachments === undefined || source.attachments?.length === 0) return undefined;
  if (!Array.isArray(source.attachments) || source.attachments.length !== 1)
    throw discordRefusal('resource-unavailable');
  const file = source.attachments[0];
  if (!discordSnowflake(file?.id) || !safeName(file.filename) || file.ephemeral === true
    || !Number.isSafeInteger(file.size) || file.size < 1) throw discordRefusal('resource-unavailable');
  if (file.size > MAX_BYTES) throw discordRefusal('artifact-too-large');
  return Object.freeze({
    id: createHash('sha256').update(JSON.stringify([route.conversationId, route.threadId ?? null, route.messageId, file.id])).digest('hex'),
    messageId: route.messageId, resourceKey: file.id, name: file.filename, sizeBytes: file.size,
    ...(typeof file.content_type === 'string' && file.content_type.length <= 127 && MIME.test(file.content_type)
      ? { mediaType: file.content_type } : {}),
  });
}

/** Safe native metadata only; signed URLs never leave the Provider. */
export function externalAttachments(evidence, source) {
  const attachment = attachmentFor(source, evidence.reply);
  return attachment ? Object.freeze({ ...evidence, attachments: Object.freeze([attachment]) }) : evidence;
}

export async function readExternalFile(api, account, route, attachment, { signal, assertCurrent }) {
  assertCurrent();
  const checked = await qualifyDiscordReply(api, account, route, signal, { forHistory: true });
  assertCurrent();
  if (!checked.source.mentions?.some(user => user.id === account.userId)) throw discordRefusal('stale-route');
  const current = attachmentFor(checked.source, route);
  if (!current || !attachment || ['id', 'messageId', 'resourceKey', 'name', 'sizeBytes', 'mediaType']
    .some(key => current[key] !== attachment[key])) throw discordRefusal('stale-route');
  const { stream, length, cancel } = await api.downloadFileStream({ url: checked.source.attachments[0].url,
    channelId: checked.channel.channelId, attachmentId: current.resourceKey, fileName: current.name, signal });
  const iterator = stream?.[Symbol.asyncIterator]?.();
  try {
    assertCurrent();
    if (!iterator || (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) !== current.sizeBytes)))
      throw discordRefusal('resource-unavailable');
  } catch (error) { await cancel?.(); throw error; }
  return (async function* () {
    let size = 0;
    try {
      assertCurrent();
      while (true) {
        assertCurrent();
        const next = await iterator.next();
        assertCurrent();
        if (next.done) break;
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array)) throw discordRefusal('resource-unavailable');
        size += chunk.byteLength;
        if (size > MAX_BYTES || size > current.sizeBytes) throw discordRefusal('artifact-too-large');
        yield new Uint8Array(chunk);
      }
      assertCurrent();
      if (size !== current.sizeBytes) throw discordRefusal('resource-unavailable');
    } finally { await cancel?.(); await iterator.return?.(); }
  })();
}

export async function replyExternalFile(api, account, route, file, { signal, beforeSend, assertCurrent }) {
  if (typeof file?.id !== 'string' || !file.id || !safeName(file.name) || !(file.bytes instanceof Uint8Array)
    || file.bytes.byteLength < 1 || file.bytes.byteLength > MAX_BYTES
    || (file.mediaType !== undefined && (typeof file.mediaType !== 'string' || file.mediaType.length > 127 || !MIME.test(file.mediaType))))
    throw discordRefusal('bad-request');
  assertCurrent();
  const checked = await qualifyDiscordReply(api, account, route, signal, { forReply: true, forFileReply: true });
  assertCurrent();
  if (beforeSend && beforeSend() !== true) throw discordRefusal('stale-route');
  signal?.throwIfAborted();
  let sent;
  try {
    sent = await api.createFileMessage({ channelId: checked.channel.channelId,
      replyToMessageId: route.messageId, signal, retry: false, failIfNotExists: true,
      file: { fileName: file.name, bytes: Buffer.from(file.bytes), mediaType: file.mediaType } });
  } catch (error) {
    if (error?.code === 'artifact-too-large') throw discordRefusal('artifact-too-large');
    if (['artifact-permission-required', 'artifact-provider-rejected', 'artifact-rate-limited'].includes(error?.code))
      throw discordRefusal('file-provider-rejected');
    throw discordRefusal('reply-result-unknown');
  }
  const result = sent?.attachments?.[0];
  if (!discordSnowflake(sent?.id) || sent.channel_id !== checked.channel.channelId
    || sent.author?.id !== account.userId || sent.author.bot !== true
    || sent.message_reference?.message_id !== route.messageId || sent.message_reference?.channel_id !== checked.channel.channelId
    || sent.attachments?.length !== 1 || !discordSnowflake(result?.id)
    || result.filename !== file.name || result.size !== file.bytes.byteLength) throw discordRefusal('reply-result-unknown');
  return { sent: true };
}
