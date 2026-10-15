import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { externalAttachments, readExternalFile, replyExternalFile } from '../../../src/channels/feishu/external-files.mjs';

const route = { messageId: 'mention', conversationId: 'group', actorId: 'human', threadId: 'topic', rootId: 'file', parentId: 'file' };
const source = { message_id: 'mention', chat_id: 'group', sender: { sender_type: 'user', id_type: 'open_id', id: 'human' }, thread_id: 'topic', root_id: 'file', parent_id: 'file' };
const parent = { message_id: 'file', chat_id: 'group', msg_type: 'file', thread_id: 'topic', body: { content: JSON.stringify({ file_key: 'resource', file_name: 'source.zip' }) } };
function fixture() {
  let downloads = 0;
  const calls = [];
  let bytes = Buffer.from('ZIP');
  let interrupted = false;
  const client = { im: { v1: {
    message: {
      get: async ({ path }) => ({ data: { items: [path.message_id === 'mention' ? source : parent] } }),
      reply: async (value) => { calls.push(value); return { data: { message_id: 'result', chat_id: 'group', thread_id: 'topic' } }; },
    },
    messageResource: { get: async (value) => { downloads++; calls.push(value); return { getReadableStream: () => Readable.from([bytes]) }; } },
    file: { create: async (value) => { calls.push(value); interrupted = true; return { data: { file_key: 'new-resource' } }; } },
  } } };
  return { client, calls, get downloads() { return downloads; }, setBytes(value) { bytes = value; }, get interrupted() { return interrupted; } };
}
const context = () => ({ signal: new AbortController().signal, assertCurrent() {} });

test('native media metadata and its cover require explicit opt-in and remain bound to the exact parent', async () => {
  const fx = fixture();
  let media = { ...parent, msg_type: 'media', body: { content: JSON.stringify({ file_key: 'native-video', file_name: 'clip.mp4', duration: 4000, image_key: 'native-cover' }) } };
  fx.client.im.v1.message.get = async ({ path }) => ({ data: { items: [path.message_id === 'mention' ? source : media] } });
  const input = { mentionedAccount: true, reply: route };
  assert.equal((await externalAttachments(fx.client, input, context().signal)).attachments, undefined);
  assert.equal((await externalAttachments(fx.client, { ...input, mentionedAccount: false }, context().signal, { sourceVideos: true })).attachments, undefined);
  const evidence = await externalAttachments(fx.client, input, context().signal, { sourceVideos: true, sourceImages: true });
  assert.equal(fx.downloads, 0);
  assert.equal(evidence.video.durationMs, 4000);
  assert.deepEqual(evidence.attachments.map(item => item.mediaType), ['video/unknown', 'image/unknown']);
  assert.equal(evidence.video.itemId, evidence.attachments[0].id);
  assert.equal(evidence.video.posterAttachmentId, evidence.attachments[1].id);
  for (const [index, type] of [[0, 'file'], [1, 'image']]) {
    const stream = await readExternalFile(fx.client, route, evidence.attachments[index], context());
    for await (const chunk of stream) void chunk;
    assert.deepEqual(fx.calls[index], { path: { message_id: 'file', file_key: index ? 'native-cover' : 'native-video' }, params: { type } });
  }
  media = { ...media, body: { content: JSON.stringify({ file_key: 'changed-video', file_name: 'clip.mp4' }) } };
  await assert.rejects(readExternalFile(fx.client, route, evidence.attachments[0], context()), { code: 'stale-route' });
  assert.equal(fx.downloads, 2);
  media = { ...media, chat_id: 'other-chat' };
  await assert.rejects(externalAttachments(fx.client, input, context().signal, { sourceVideos: true }), { code: 'stale-route' });
});

test('native media without optional duration or cover stays playable; a file named mp4 is still a file', async () => {
  const fx = fixture();
  let media = { ...parent, msg_type: 'media', body: { content: JSON.stringify({ file_key: 'native-video', file_name: 'clip.mp4' }) } };
  fx.client.im.v1.message.get = async () => ({ data: { items: [media] } });
  const input = { mentionedAccount: true, reply: route };
  const evidence = await externalAttachments(fx.client, input, context().signal, { sourceVideos: true });
  assert.deepEqual(evidence.video, { itemId: evidence.attachments[0].id });
  assert.equal(evidence.attachments.length, 1);
  media = { ...media, msg_type: 'file' };
  const generic = await externalAttachments(fx.client, input, context().signal, { sourceVideos: true });
  assert.equal(generic.video, undefined);
  assert.equal(generic.attachments[0].mediaType, undefined);
});

test('trusted parent metadata is lazy and mismatched evidence cannot fetch another resource', async () => {
  const fx = fixture();
  const evidence = await externalAttachments(fx.client, { mentionedAccount: true, reply: route }, context().signal);
  assert.equal(fx.downloads, 0);
  assert.equal(evidence.attachments[0].name, 'source.zip');
  await assert.rejects(readExternalFile(fx.client, route, { ...evidence.attachments[0], resourceKey: 'other' }, context()), { code: 'stale-route' });
  assert.equal(fx.downloads, 0);
  const stream = await readExternalFile(fx.client, route, evidence.attachments[0], context());
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'ZIP');
  assert.deepEqual(fx.calls[0].path, { message_id: 'file', file_key: 'resource' });
});

test('bounded download refuses oversize and cancellation destroys the stream', async () => {
  const fx = fixture();
  const attachment = (await externalAttachments(fx.client, { mentionedAccount: true, reply: route }, context().signal)).attachments[0];
  fx.setBytes(Buffer.alloc(25 * 1024 * 1024 + 1));
  const data = await readExternalFile(fx.client, route, attachment, context());
  await assert.rejects(async () => { for await (const chunk of data) void chunk; }, { code: 'artifact-too-large' });
  const controller = new AbortController();
  const cancelled = await readExternalFile(fx.client, route, attachment, { signal: controller.signal, assertCurrent() {} });
  controller.abort();
  await assert.rejects(async () => { for await (const chunk of cancelled) void chunk; });
});

test('file upload rechecks identity before the exact original topic reply; no stale send fallback', async () => {
  const fx = fixture();
  const file = { id: 'intent', name: 'new.zip', bytes: Buffer.from('NEW') };
  await assert.rejects(replyExternalFile(fx.client, route, file, { signal: context().signal, assertCurrent() {
    if (fx.interrupted) throw Object.assign(new Error('account-changed'), { code: 'account-changed' });
  } }), { code: 'account-changed' });
  assert.equal(fx.calls.length, 1);
  const good = fixture();
  assert.deepEqual(await replyExternalFile(good.client, route, file, context()), { sent: true });
  assert.equal(good.calls[1].path.message_id, 'mention');
  assert.equal(good.calls[1].data.reply_in_thread, true);
  assert.equal(good.calls[1].data.msg_type, 'file');
  assert.equal(JSON.parse(good.calls[1].data.content).file_key, 'new-resource');
});
