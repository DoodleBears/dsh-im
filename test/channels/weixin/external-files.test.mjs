import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveWeixinBotIdentity } from '../../../src/channels/weixin/config-store.mjs';
import { pairedWeixinAccount, normalizeWeixinExternalText } from '../../../src/channels/weixin/external-consumer.mjs';
import { privateWeixinFile } from '../../../src/channels/weixin/external-files.mjs';
import { WeixinRuntime } from '../../../src/channels/weixin/weixin-runtime.mjs';
import { WeixinStateStore } from '../../../src/channels/weixin/state-store.mjs';
import { createWeixinApi, extractWeixinFiles } from '../../../src/channels/weixin/weixin-api.mjs';

const config = { ...deriveWeixinBotIdentity('qa.bot'), accountId: 'qa.bot', ownerUserId: 'owner',
  connectedAt: '2026-10-05T00:00:00Z', baseUrl: 'https://ilinkai.weixin.qq.com/', consumerMode: 'external-consumer' };
const account = pairedWeixinAccount(config, 'token');
const key = Buffer.alloc(16, 0x42);
const bytes = Buffer.from('original file');
const message = { message_type: 1, from_user_id: 'owner', to_user_id: 'qa.bot',
  message_id: '9007199254740993', create_time_ms: 1791158400000, context_token: 'private-context',
  item_list: [{ type: 4, file_item: { file_name: '微信文件.zip', len: String(bytes.length),
    media: { aes_key: key.toString('base64'), encrypt_query_param: 'private-ticket', encrypt_type: 1 } } }] };
const eventOf = (value = message) => normalizeWeixinExternalText(value, { botId: config.botId, account, sourceFiles: true });
const sourceOf = (event, value = message) => ({ messageId: event.messageId, actorId: 'owner', fingerprint: account.fingerprint,
  contextToken: value.context_token, expiresAt: Date.now() + 10000, file: privateWeixinFile(value, event) });

test('file-only and captioned native owner events retain safe source metadata without leaking continuation or CDN keys', () => {
  assert.equal(normalizeWeixinExternalText(message, { botId: config.botId, account }), null);
  const event = eventOf();
  assert.equal(event.messageId, message.message_id);
  assert.equal(event.text, '[File: 微信文件.zip]');
  assert.equal(event.attachments[0].sizeBytes, bytes.length);
  for (const privateValue of ['private-context', 'private-ticket', key.toString('base64')])
    assert.ok(!JSON.stringify(event).includes(privateValue));
  const captioned = eventOf({ ...message, item_list: [{ type: 1, text_item: { text: 'Process this' } }, ...message.item_list] });
  assert.equal(captioned.text, 'Process this');
  assert.deepEqual(captioned.attachments, event.attachments);
  assert.equal(eventOf({ ...message, from_user_id: 'stranger' }), null);
  assert.equal(eventOf({ ...message, item_list: [{ type: 2 }] }), null);
  assert.throws(() => eventOf({ ...message, item_list: [...message.item_list, ...message.item_list] }), { code: 'resource-unavailable' });
});

test('a private file ticket survives reload, downloads lazily, and cannot be redirected by forged metadata or expired sources', async () => {
  const event = eventOf();
  const path = join(await mkdtemp(join(tmpdir(), 'weixin-reload-')), 'state.json');
  const persisted = await new WeixinStateStore(path).load();
  await persisted.rememberExternalReplySource(sourceOf(event));
  const reloaded = await new WeixinStateStore(path).load();
  assert.ok(!JSON.stringify(reloaded.snapshot()).includes('private-ticket'));
  let downloads = 0;
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const runtime = new WeixinRuntime({ config, token: 'token', state: reloaded, harness: {}, api: createWeixinApi({
    fetchImpl: async () => { downloads++; return new Response(ciphertext); },
  }) });
  await assert.rejects(runtime.externalFileChecked(event.reply, { ...event.attachments[0], resourceKey: 'forged' }, { account }), { code: 'stale-route' });
  assert.equal(downloads, 0);
  const stream = await runtime.externalFileChecked(event.reply, event.attachments[0], { account });
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(downloads, 1);
  await reloaded.rememberExternalReplySource({ ...sourceOf(event), expiresAt: 1 });
  await assert.rejects(runtime.externalFileChecked(event.reply, event.attachments[0], { account }), { code: 'stale-route' });
  assert.equal(downloads, 1);
});

test('oversized source metadata remains inspectable but download is refused before touching the CDN', async () => {
  const large = { ...message, item_list: [{ type: 4, file_item: { ...message.item_list[0].file_item, len: String(30 * 1024 * 1024) } }] };
  const event = eventOf(large);
  assert.equal(event.attachments[0].sizeBytes, 30 * 1024 * 1024);
  const source = sourceOf(event, large);
  const runtime = new WeixinRuntime({ config, token: 'token', harness: {}, state: { externalReplySource: () => source }, api: {
    inboundFiles: () => assert.fail('oversized file must not fetch'),
  } });
  await assert.rejects(runtime.externalFileChecked(event.reply, event.attachments[0], { account }), { code: 'artifact-too-large' });
});

test('streaming file download enforces an actual byte bound even without an honest Content-Length', async () => {
  const files = extractWeixinFiles(message, { fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(80)); controller.close();
  } }), { headers: { 'Content-Length': '1' } }) });
  await assert.rejects(files[0].load({ maxBytes: 32 }), { code: 'artifact-too-large' });
});

test('file upload rechecks authorization after CDN upload and never performs final send after revocation', async () => {
  let current = true;
  let finalSends = 0;
  let uploads = 0;
  const api = createWeixinApi({ fetchImpl: async url => {
    if (url.pathname.endsWith('/getuploadurl')) return Response.json({ ret: 0, upload_param: 'upload' });
    finalSends++; return Response.json({ ret: 0 });
  }, uploadFetchImpl: async (_url, input) => {
    for await (const _chunk of input.body) {} uploads++; current = false;
    return new Response(null, { headers: { 'x-encrypted-param': 'download' } });
  } });
  const event = eventOf(); const source = sourceOf(event);
  const runtime = new WeixinRuntime({ config, token: 'token', harness: {}, state: { externalReplySource: () => source }, api });
  await assert.rejects(runtime.externalFileChecked(event.reply, { id: 'result', name: 'result.zip', bytes },
    { account, beforeSend: () => current, reply: true }), { code: 'stale-route' });
  assert.equal(uploads, 1);
  assert.equal(finalSends, 0);
});

test('exclusive controller advertises fenced file support and binds file access to its live consumer lease', async () => {
  const { WeixinController } = await import('../../../src/channels/weixin/weixin-controller.mjs');
  const { WeixinConfigStore } = await import('../../../src/channels/weixin/config-store.mjs');
  const root = await mkdtemp(join(tmpdir(), 'weixin-file-controller-'));
  const store = await new WeixinConfigStore(join(root, 'config.json')).load();
  await store.save(config);
  let receive;
  let ready = false;
  let checked;
  const controller = new WeixinController({ api: { beginLogin() {}, pollLogin() {} }, configStore: store,
    credentials: { resolve: async () => ({ value: 'token' }), set: async () => {}, unset: async () => {} }, createRuntime: async input => {
      receive = input.externalConsumer;
      return { start: async () => { ready = true; }, stop: async () => { ready = false; },
        get status() { return { ready }; }, externalFileChecked: async (_route, _file, options) => { checked = options; return { sent: true }; } };
    } });
  const info = await controller.describeDeliveryAccount(config.botId);
  assert.ok(info.capabilities.includes('reply-file-fence-checked'));
  const state = await new WeixinStateStore(join(root, 'state.json')).load();
  let canonical;
  const dispose = await controller.consumeInbound(config.botId, { expectedFingerprint: account.fingerprint,
    sourceFiles: true, onEvent: async event => { canonical = event; return { accepted: true }; } });
  await receive(message, state, new AbortController().signal);
  assert.deepEqual(canonical.attachments, eventOf().attachments);
  assert.equal(state.externalReplySource(message.message_id).file.item.media.encrypt_query_param, 'private-ticket');
  const beforeSend = () => true;
  await controller.externalFileChecked(config.botId, canonical.reply, { id: 'result' },
    { expectedFingerprint: account.fingerprint, reply: true, beforeSend });
  assert.equal(checked.beforeSend, beforeSend);
  assert.equal(checked.account.fingerprint, account.fingerprint);
  assert.equal(checked.signal.aborted, false);
  dispose();
  assert.equal(checked.signal.aborted, true);
  await assert.rejects(controller.externalFileChecked(config.botId, canonical.reply, {},
    { expectedFingerprint: account.fingerprint }), { code: 'consumer-unavailable' });
  await controller.close();
});
