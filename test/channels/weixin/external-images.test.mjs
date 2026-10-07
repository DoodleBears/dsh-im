import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv } from 'node:crypto';
import { pairedWeixinAccount, normalizeWeixinExternalText } from '../../../src/channels/weixin/external-consumer.mjs';
import { deriveWeixinBotIdentity } from '../../../src/channels/weixin/config-store.mjs';
import { privateWeixinFile, readWeixinExternalFile, replyWeixinExternalFile } from '../../../src/channels/weixin/external-files.mjs';
import { createWeixinApi } from '../../../src/channels/weixin/weixin-api.mjs';

const config = { ...deriveWeixinBotIdentity('qa.bot'), accountId: 'qa.bot', ownerUserId: 'owner', connectedAt: '2026-10-05T00:00:00Z', baseUrl: 'https://ilinkai.weixin.qq.com/', consumerMode: 'external-consumer' };
const account = pairedWeixinAccount(config, 'token');
const key = Buffer.alloc(16, 0x42);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4S8AAAAASUVORK5CYII=', 'base64');
const message = { message_type: 1, from_user_id: 'owner', to_user_id: 'qa.bot', message_id: '9007199254740993',
  create_time_ms: 1791158400000, context_token: 'private-context', item_list: [{ type: 2, image_item: {
    aeskey: key.toString('hex'), media: { encrypt_query_param: 'private-ticket', encrypt_type: 1 } } }] };
const eventOf = (value = message) => normalizeWeixinExternalText(value, { botId: config.botId, account, sourceImages: true });

test('image-only intake is separately opt-in and retains one safe source with no keys or invented MIME/size', () => {
  assert.equal(normalizeWeixinExternalText(message, { botId: config.botId, account, sourceFiles: true }), null);
  const event = eventOf();
  assert.equal(event.text, '[Image]');
  assert.equal(event.attachments[0].mediaType, 'image/unknown');
  assert.equal(event.attachments[0].sizeBytes, undefined);
  assert.equal(event.attachments[0].messageId, message.message_id);
  for (const value of ['private-context', 'private-ticket', key.toString('hex')]) assert.ok(!JSON.stringify(event).includes(value));
  const captioned = eventOf({ ...message, item_list: [{ type: 1, text_item: { text: 'inspect' } }, ...message.item_list] });
  assert.equal(captioned.text, 'inspect');
  assert.deepEqual(captioned.attachments, event.attachments);
  assert.equal(eventOf({ ...message, from_user_id: 'stranger' }), null);
  assert.equal(eventOf({ ...message, group_id: 'native-group' }), null);
  assert.equal(eventOf({ ...message, item_list: [{ type: 3, voice_item: {} }] }), null);
  assert.throws(() => eventOf({ ...message, item_list: [...message.item_list, ...message.item_list] }), { code: 'resource-unavailable' });
});

test('checked image download preserves native hex AES keys privately, validates bytes and refuses forged metadata', async () => {
  const event = eventOf(); const source = { file: privateWeixinFile(message, event) };
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  let fetches = 0;
  const api = createWeixinApi({ fetchImpl: async () => { fetches++; return new Response(encrypted); } });
  await assert.rejects(readWeixinExternalFile(api, source, { ...event.attachments[0], name: 'forged' }, { assertCurrent() {} }), { code: 'stale-route' });
  assert.equal(fetches, 0);
  const stream = await readWeixinExternalFile(api, source, event.attachments[0], { assertCurrent() {} });
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), png);
  await assert.rejects(readWeixinExternalFile({ inboundImages: () => [{ load: async () => Buffer.from('not image') }] }, source, event.attachments[0], { assertCurrent() {} }), { code: 'resource-unavailable' });
});

test('native image reply selects native image upload and refuses false image MIME before any effect', async () => {
  let imageSends = 0; let fences = 0;
  const api = { sendFile: async () => assert.fail('image must remain a native image'), sendImage: async request => {
    imageSends++; request.beforeSend(); assert.deepEqual(request.file.bytes, png); return { messageId: 'dsh-weixin-image' };
  } };
  await assert.rejects(replyWeixinExternalFile(api, {}, { id: 'result', name: 'result.png', bytes: png, mediaType: 'image/jpeg' }, { assertCurrent() {} }), { code: 'bad-request' });
  assert.equal(imageSends, 0);
  assert.deepEqual(await replyWeixinExternalFile(api, {}, { id: 'result', name: 'result.png', bytes: png, mediaType: 'image/png' }, { assertCurrent() { fences++; } }), { sent: true });
  assert.equal(imageSends, 1); assert.equal(fences, 3);
});

test('native image upload revocation prevents final send while retaining the uncertain send boundary', async () => {
  let current = true; let finalSends = 0;
  const api = createWeixinApi({ fetchImpl: async url => {
    if (url.pathname.endsWith('/getuploadurl')) return Response.json({ ret: 0, upload_param: 'upload' });
    finalSends++; return Response.json({ ret: 0 });
  }, uploadFetchImpl: async () => { current = false; return new Response(null, { headers: { 'x-encrypted-param': 'download' } }); } });
  await assert.rejects(replyWeixinExternalFile(api, { baseUrl: 'https://ilinkai.weixin.qq.com', token: 'token', toUserId: 'owner', contextToken: 'context' },
    { id: 'result', name: 'result.png', bytes: png, mediaType: 'image/png' }, { assertCurrent() { if (!current) throw Object.assign(new Error('stale-route'), { code: 'stale-route' }); } }), { code: 'stale-route' });
  assert.equal(finalSends, 0);
});


test('controller negotiates image intake separately and retains a private ticket only under its live lease', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { WeixinController } = await import('../../../src/channels/weixin/weixin-controller.mjs');
  const { WeixinConfigStore } = await import('../../../src/channels/weixin/config-store.mjs');
  const { WeixinStateStore } = await import('../../../src/channels/weixin/state-store.mjs');
  const root = await mkdtemp(join(tmpdir(), 'weixin-image-controller-'));
  const store = await new WeixinConfigStore(join(root, 'config.json')).load(); await store.save(config);
  let receive; let ready = false; let canonical;
  const controller = new WeixinController({ api: { beginLogin() {}, pollLogin() {} }, configStore: store,
    credentials: { resolve: async () => ({ value: 'token' }), set: async () => {}, unset: async () => {} },
    createRuntime: async input => { receive = input.externalConsumer; return {
      start: async () => { ready = true; }, stop: async () => { ready = false; }, get status() { return { ready }; },
    }; } });
  try {
    const info = await controller.describeDeliveryAccount(config.botId);
    assert.ok(info.capabilities.includes('source-image-checked'));
    assert.ok(info.capabilities.includes('reply-image-fence-checked'));
    const state = await new WeixinStateStore(join(root, 'state.json')).load();
    const filesOnly = await controller.consumeInbound(config.botId, { expectedFingerprint: account.fingerprint,
      sourceFiles: true, onEvent: async () => assert.fail('files opt-in must not admit images') });
    await receive(message, state, new AbortController().signal);
    assert.equal(state.externalReplySource(message.message_id), undefined);
    filesOnly();
    const dispose = await controller.consumeInbound(config.botId, { expectedFingerprint: account.fingerprint,
      sourceImages: true, onEvent: async event => { canonical = event; return { accepted: true }; } });
    await receive(message, state, new AbortController().signal);
    assert.deepEqual(canonical.attachments, eventOf().attachments);
    assert.equal(state.externalReplySource(message.message_id).file.kind, 'image');
    assert.ok(!JSON.stringify(canonical).includes('private-ticket'));
    dispose();
    await assert.rejects(receive(message, state, new AbortController().signal), { code: 'consumer-unavailable' });
  } finally { await controller.close(); }
});
