import { createHash } from 'node:crypto';
import { slackRefusal } from './external-consumer.mjs';

const MAX_BYTES = 25 * 1024 * 1024;

function attachmentFor(source, route) {
  if (!Array.isArray(source.files) || source.files.length === 0) return undefined;
  // The checked source-file contract currently represents one file per Source Event.
  if (source.files.length !== 1) throw slackRefusal('resource-unavailable');
  const file = source.files[0];
  if (!/^F[A-Z0-9]{4,30}$/.test(file?.id ?? '') || typeof file.name !== 'string'
    || !file.name.trim() || file.name.length > 512 || /[\x00-\x1f\x7f]/.test(file.name)
    || file.deleted === true || (file.mode !== undefined && file.mode !== 'hosted'))
    throw slackRefusal('resource-unavailable');
  if (Number.isFinite(file.size) && file.size > MAX_BYTES) throw slackRefusal('artifact-too-large');
  return Object.freeze({
    id: createHash('sha256').update(JSON.stringify([route.conversationId, route.messageId, file.id])).digest('hex'),
    messageId: route.messageId, resourceKey: file.id, name: file.name,
    ...(Number.isSafeInteger(file.size) && file.size > 0 ? { sizeBytes: file.size } : {}),
    ...(typeof file.mimetype === 'string' && file.mimetype.length <= 127
      && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.mimetype) ? { mediaType: file.mimetype } : {}),
  });
}

/** Only safe native file identity is persisted; private download URLs remain inside the Provider. */
export async function externalAttachments(evidence, source) {
  const attachment = attachmentFor(await source(), evidence.reply);
  return attachment ? Object.freeze({ ...evidence, attachments: Object.freeze([attachment]) }) : evidence;
}

export async function readExternalFile(api, route, attachment, { signal, assertCurrent, source }) {
  assertCurrent();
  const current = attachmentFor(await source(), route);
  if (!current || !attachment || current.id !== attachment.id || current.messageId !== attachment.messageId
    || current.resourceKey !== attachment.resourceKey || current.name !== attachment.name
    || current.sizeBytes !== attachment.sizeBytes || current.mediaType !== attachment.mediaType)
    throw slackRefusal('stale-route');
  assertCurrent();
  const file = await api.fileInfo({ fileId: current.resourceKey, signal });
  assertCurrent();
  if (file?.id !== current.resourceKey || file.deleted === true || file.mode !== 'hosted'
    || file.name !== current.name || !Number.isSafeInteger(file.size) || file.size < 1)
    throw slackRefusal('resource-unavailable');
  if (file.size > MAX_BYTES) throw slackRefusal('artifact-too-large');
  const { stream } = await api.downloadFileStream({ url: file.url_private_download ?? file.url_private, signal });
  assertCurrent();
  if (!stream?.[Symbol.asyncIterator]) throw slackRefusal('resource-unavailable');
  return (async function* () {
    let size = 0;
    try {
      assertCurrent();
      for await (const chunk of stream) {
        assertCurrent();
        if (!(chunk instanceof Uint8Array)) throw slackRefusal('resource-unavailable');
        size += chunk.byteLength;
        if (size > MAX_BYTES || size > file.size) throw slackRefusal('artifact-too-large');
        yield new Uint8Array(chunk);
      }
      assertCurrent();
      if (size !== file.size) throw slackRefusal('resource-unavailable');
    } finally {
      stream.destroy?.();
      await stream.cancel?.().catch(() => undefined);
    }
  })();
}

export async function replyExternalFile(api, route, file, { signal, assertCurrent, source }) {
  if (typeof file?.id !== 'string' || !file.id || typeof file.name !== 'string' || !file.name.trim()
    || file.name.length > 512 || /[\x00-\x1f\x7f]/.test(file.name) || !(file.bytes instanceof Uint8Array)
    || file.bytes.byteLength < 1 || file.bytes.byteLength > MAX_BYTES) throw slackRefusal('bad-request');
  assertCurrent();
  await source();
  assertCurrent();
  try {
    await api.uploadFile({ channelId: route.conversationId, threadTs: route.threadId,
      file: { fileName: file.name, bytes: Buffer.from(file.bytes) }, signal,
      beforeSend: async () => {
        await source();
        assertCurrent();
      },
    });
    return { sent: true };
  } catch (error) {
    if (error?.code === 'artifact-provider-failed') throw slackRefusal('file-upload-failed');
    if (['artifact-permission-required', 'artifact-too-large', 'artifact-provider-rejected', 'artifact-rate-limited'].includes(error?.code))
      throw slackRefusal('file-provider-rejected');
    throw error;
  }
}
