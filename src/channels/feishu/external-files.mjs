import { nativeImageContent } from './external-images.mjs';
import { createHash } from 'node:crypto';
import { VerifiedFeishuChannel } from './feishu-channel.mjs';

const MAX_BYTES = 25 * 1024 * 1024;
const failure = (code) => Object.assign(new Error(code), { code });

export async function checkedReplySource(client, route, signal) {
  signal?.throwIfAborted();
  if (!route || !route.messageId || !route.conversationId || !route.actorId) throw failure('bad-request');
  const current = await client.im.v1.message.get({ path: { message_id: route.messageId } });
  const source = current?.data?.items?.find(item => item.message_id === route.messageId);
  if (current?.code || !source || source.deleted === true || source.chat_id !== route.conversationId
    || source.sender?.sender_type !== 'user' || source.sender?.id_type !== 'open_id'
    || source.sender?.id !== route.actorId || (source.thread_id || undefined) !== route.threadId
    || (source.root_id || undefined) !== route.rootId || (source.parent_id || undefined) !== route.parentId)
    throw failure('stale-route');
  signal?.throwIfAborted();
  return source;
}

export function nativeFileContent(message, conversationId) {
  if ((message.message_type ?? message.msg_type) !== 'file') return undefined;
  let content;
  try { content = JSON.parse(message.content ?? message.body?.content); } catch { throw failure('invalid-inbound'); }
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
  if (!valid(message.message_id) || !valid(conversationId) || !valid(content?.file_key) || !valid(content?.file_name)) throw failure('invalid-inbound');
  const attachment = Object.freeze({
    id: createHash('sha256').update(JSON.stringify([conversationId, message.message_id, content.file_key])).digest('hex'),
    messageId: message.message_id, resourceKey: content.file_key, name: content.file_name,
  });
  // Native file messages contain one resource. No invented mixed-item order or MIME/size.
  return { text: '[File] ' + attachment.name, attachments: [attachment] };
}

async function parentFile(client, route, signal) {
  if (!route.parentId || route.parentId === route.messageId) return undefined;
  signal?.throwIfAborted();
  const result = await client.im.v1.message.get({ path: { message_id: route.parentId } });
  const file = result?.data?.items?.find(item => item.message_id === route.parentId);
  if (result?.code || !file || file.deleted === true || file.chat_id !== route.conversationId)
    throw failure('stale-route');
  if (file.msg_type !== 'file') return undefined;
  if (file.thread_id && route.threadId && file.thread_id !== route.threadId) throw failure('stale-route');
  let content;
  try { content = JSON.parse(file.body?.content); } catch { throw failure('invalid-inbound'); }
  if (typeof content?.file_key !== 'string' || !content.file_key || content.file_key.length > 512
    || typeof content.file_name !== 'string' || !content.file_name || content.file_name.length > 512)
    throw failure('invalid-inbound');
  signal?.throwIfAborted();
  return Object.freeze({
    id: createHash('sha256').update(JSON.stringify([route.conversationId, file.message_id, content.file_key])).digest('hex'),
    messageId: file.message_id, resourceKey: content.file_key, name: content.file_name,
  });
}

export async function externalAttachments(client, evidence, signal) {
  if (evidence.attachments?.length || !evidence.mentionedAccount || !evidence.reply.parentId) return evidence;
  const file = await parentFile(client, evidence.reply, signal);
  return file ? Object.freeze({ ...evidence, attachments: Object.freeze([file]) }) : evidence;
}

export async function readExternalFile(client, route, attachment, { signal, assertCurrent }) {
  const source = await checkedReplySource(client, route, signal);
  const ownImages = nativeImageContent(source, route.conversationId);
  const current = attachment.mediaType === 'image/unknown'
    ? ownImages?.attachments.find(item => item.id === attachment.id)
    : nativeFileContent(source, route.conversationId)?.attachments[0] ?? await parentFile(client, route, signal);
  if (!current || JSON.stringify(current) !== JSON.stringify(attachment)) throw failure('stale-route');
  assertCurrent();
  const resource = await client.im.v1.messageResource.get({
    path: { message_id: current.messageId, file_key: current.resourceKey }, params: { type: current.mediaType === 'image/unknown' ? 'image' : 'file' },
  });
  signal?.throwIfAborted();
  assertCurrent();
  const stream = resource?.getReadableStream?.();
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw failure('resource-unavailable');
  const declared = Number(resource?.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    stream.destroy?.();
    throw failure('artifact-too-large');
  }
  const cancel = () => stream.destroy?.();
  signal?.addEventListener('abort', cancel, { once: true });
  return (async function* () {
    let size = 0;
    try {
      signal?.throwIfAborted();
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        assertCurrent();
        size += chunk.byteLength;
        if (size > MAX_BYTES) throw failure('artifact-too-large');
        yield new Uint8Array(chunk);
      }
      signal?.throwIfAborted();
      assertCurrent();
    } finally {
      signal?.removeEventListener('abort', cancel);
      stream.destroy?.();
    }
  })();
}

export async function replyExternalFile(client, route, file, { signal, assertCurrent }) {
  if (!file || typeof file.id !== 'string' || !file.id || typeof file.name !== 'string'
    || !file.name || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength < 1
    || file.bytes.byteLength > MAX_BYTES) throw failure('bad-request');
  await checkedReplySource(client, route, signal);
  assertCurrent();
  const channel = new VerifiedFeishuChannel({ client });
  try {
    await channel.sendFile(route.conversationId, {
      artifactId: file.id, deliveryKey: file.id, fileName: file.name, bytes: Buffer.from(file.bytes),
    }, { replyTo: route.messageId, replyInThread: Boolean(route.threadId), signal,
      retryUncertain: false,
      beforeSend: async () => {
        await checkedReplySource(client, route, signal);
        assertCurrent();
      },
    });
    return { sent: true };
  } catch (error) {
    if (error?.code === 'artifact-provider-failed') throw failure('file-upload-failed');
    if (['artifact-permission-required', 'artifact-too-large', 'artifact-empty', 'artifact-provider-rejected', 'artifact-rate-limited'].includes(error?.code))
      throw failure('file-provider-rejected');
    throw error;
  }
}
