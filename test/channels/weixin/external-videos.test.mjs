import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv } from 'node:crypto';
import { pairedWeixinAccount, normalizeWeixinExternalText } from '../../../src/channels/weixin/external-consumer.mjs';
import { deriveWeixinBotIdentity } from '../../../src/channels/weixin/config-store.mjs';
import { privateWeixinFile, readWeixinExternalFile, replyWeixinExternalFile } from '../../../src/channels/weixin/external-files.mjs';
import { createWeixinApi } from '../../../src/channels/weixin/weixin-api.mjs';

const config = { ...deriveWeixinBotIdentity('qa.bot'), accountId: 'qa.bot', ownerUserId: 'owner', connectedAt: '2026-10-06T00:00:00Z', baseUrl: 'https://ilinkai.weixin.qq.com/', consumerMode: 'external-consumer' };
const account = pairedWeixinAccount(config, 'token');
const key = Buffer.alloc(16, 0x42);
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432000000086d646174', 'hex');
const message = { message_type: 1, from_user_id: 'owner', to_user_id: 'qa.bot', message_id: '9007199254740993', create_time_ms: 1791294600000, context_token: 'private-context', item_list: [{ type: 5, msg_id: 'native-item', video_item: { play_length: 7000, video_size: 48, media: { aes_key: key.toString('base64'), encrypt_query_param: 'private-ticket', encrypt_type: 1 }, thumb_media: { full_url: 'private-thumb' } } }] };
const eventOf = (value = message) => normalizeWeixinExternalText(value, { botId: config.botId, account, sourceVideos: true });

test('native video opt-in preserves safe metadata without inventing plaintext size or leaking media keys', () => {
  assert.equal(normalizeWeixinExternalText(message, { botId: config.botId, account, sourceFiles: true, sourceImages: true }), null);
  const event = eventOf();
  assert.equal(event.text, '[Video]');
  assert.equal(event.attachments[0].mediaType, 'video/unknown');
  assert.equal(event.attachments[0].sizeBytes, undefined);
  assert.deepEqual(event.video, { ciphertextSizeBytes: 48, playLength: 7000, itemId: 'native-item' });
  for (const value of ['private-context', 'private-ticket', 'private-thumb', key.toString('base64')]) assert.ok(!JSON.stringify(event).includes(value));
  assert.equal(eventOf({ ...message, from_user_id: 'stranger' }), null);
  assert.equal(eventOf({ ...message, group_id: 'group' }), null);
  assert.throws(() => eventOf({ ...message, to_user_id: 'other-bot' }), { code: 'account-changed' });
  assert.throws(() => eventOf({ ...message, item_list: [...message.item_list, ...message.item_list] }), { code: 'resource-unavailable' });
  assert.equal(eventOf({ ...message, message_state: 1 }), null);
});

test('video decryption uses the private source and current fence, not ciphertext size as plaintext size', async () => {
  const event = eventOf(); const source = { file: privateWeixinFile(message, event) };
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(mp4), cipher.final()]);
  let fetches = 0;
  const api = createWeixinApi({ fetchImpl: async () => { fetches++; return new Response(encrypted); } });
  await assert.rejects(readWeixinExternalFile(api, source, { ...event.attachments[0], resourceKey: 'forged' }, { assertCurrent() {} }), { code: 'stale-route' });
  assert.equal(fetches, 0);
  const body = await readWeixinExternalFile(api, source, event.attachments[0], { assertCurrent() {} });
  const chunks = []; for await (const chunk of body) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), mp4);
  await assert.rejects(readWeixinExternalFile({ inboundVideos: () => [{ load: async () => mp4 }] }, source, event.attachments[0], { assertCurrent() { throw Object.assign(new Error('stale-route'), { code: 'stale-route' }); } }), { code: 'stale-route' });
});

test('video reply uses upload media type 2 and native item type 5, checking authorization after upload', async () => {
  let current = true; const posted = [];
  const api = createWeixinApi({ fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); posted.push(body);
    if (url.pathname.endsWith('/getuploadurl')) { assert.equal(body.media_type, 2); return Response.json({ ret: 0, upload_param: 'upload' }); }
    assert.equal(body.msg.item_list[0].type, 5);
    assert.equal(body.msg.item_list[0].video_item.video_size, 48);
    assert.equal(body.msg.context_token, 'context'); return Response.json({ ret: 0 });
  }, uploadFetchImpl: async (_url, options) => { for await (const _chunk of options.body) {} return new Response(null, { headers: { 'x-encrypted-param': 'download' } }); } });
  const request = { baseUrl: config.baseUrl, token: 'token', toUserId: 'owner', contextToken: 'context' };
  const file = { id: 'clip', name: 'clip.mp4', bytes: mp4, mediaType: 'video/mp4' };
  const assertCurrent = () => { if (!current) throw Object.assign(new Error('stale-route'), { code: 'stale-route' }); };
  await assert.rejects(replyWeixinExternalFile(api, request, { ...file, bytes: Buffer.from('not-video') }, { assertCurrent }), { code: 'bad-request' });
  assert.equal(posted.length, 0);
  assert.deepEqual(await replyWeixinExternalFile(api, request, file, { assertCurrent }), { sent: true });
  assert.equal(posted.length, 2);
  const denied = createWeixinApi({ fetchImpl: async url => { if (url.pathname.endsWith('/sendmessage')) assert.fail('revoked final send'); return Response.json({ ret: 0, upload_param: 'upload' }); }, uploadFetchImpl: async (_url, options) => { for await (const _chunk of options.body) {} current = false; return new Response(null, { headers: { 'x-encrypted-param': 'download' } }); } });
  await assert.rejects(replyWeixinExternalFile(denied, request, file, { assertCurrent }), { code: 'stale-route' });
  await assert.rejects(replyWeixinExternalFile(api, request, { ...file, bytes: Buffer.alloc(25 * 1024 * 1024 + 1) }, { assertCurrent }), { code: 'bad-request' });
});
