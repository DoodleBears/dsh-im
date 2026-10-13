import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv } from 'node:crypto';
import { pairedWeixinAccount, normalizeWeixinExternalText } from '../../../src/channels/weixin/external-consumer.mjs';
import { deriveWeixinBotIdentity } from '../../../src/channels/weixin/config-store.mjs';
import { privateWeixinFile, readWeixinExternalFile } from '../../../src/channels/weixin/external-files.mjs';
import { createWeixinApi } from '../../../src/channels/weixin/weixin-api.mjs';

const config = { ...deriveWeixinBotIdentity('qa.bot'), accountId: 'qa.bot', ownerUserId: 'owner', connectedAt: '2026-10-05T00:00:00Z', baseUrl: 'https://ilinkai.weixin.qq.com/' };
const account = pairedWeixinAccount(config, 'token');
const key = Buffer.alloc(16, 0x42);
const bytes = Buffer.from([2, ...Buffer.from('#!SILK_V3'), 1, 0, 42]);
const message = { message_type: 1, from_user_id: 'owner', to_user_id: 'qa.bot', message_id: '9007199254740995', create_time_ms: 1791158400000, context_token: 'private-context', item_list: [{ type: 3, voice_item: { encode_type: 6, sample_rate: 24000, bits_per_sample: 16, playtime: 1000, media: { aes_key: key.toString('base64'), encrypt_query_param: 'private-ticket', encrypt_type: 1 } } }] };
const eventOf = (value = message) => normalizeWeixinExternalText(value, { botId: config.botId, account, sourceVoiceAudio: true });

test('raw voice is separately opted in and keeps native codec facts distinct from a missing transcript', () => {
  const transcript = normalizeWeixinExternalText(message, { botId: config.botId, account, sourceVoiceTranscripts: true });
  assert.equal(transcript.attachments, undefined);
  const event = eventOf();
  assert.deepEqual(event.voice, { transcript: 'unavailable', durationMs: 1000, encodeType: 6, sampleRate: 24000, bitsPerSample: 16 });
  assert.equal(event.attachments[0].name, 'voice.silk');
  assert.equal(event.attachments[0].mediaType, 'audio/unknown');
  assert.equal(event.attachments[0].sizeBytes, undefined);
  for (const secret of ['private-context', 'private-ticket', key.toString('base64')]) assert.ok(!JSON.stringify(event).includes(secret));
  assert.equal(eventOf({ ...message, from_user_id: 'other' }), null);
  assert.equal(eventOf({ ...message, group_id: 'group' }), null);
  const absent = eventOf({ ...message, item_list: [{ type: 3, voice_item: {} }] });
  assert.deepEqual(absent.voice, { transcript: 'unavailable' });
  assert.equal(absent.attachments, undefined);
  for (const metadata of [{ encode_type: -1 }, { sample_rate: 0.5 }, { bits_per_sample: '16' }])
    assert.throws(() => eventOf({ ...message, item_list: [{ type: 3, voice_item: metadata }] }), { code: 'invalid-inbound' });
});

test('checked original download decrypts exact raw bytes and fences forged metadata and revocation', async () => {
  const event = eventOf();
  const source = { file: privateWeixinFile(message, event) };
  assert.equal(source.file.kind, 'voice');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  let fetches = 0;
  const api = createWeixinApi({ fetchImpl: async () => { fetches++; return new Response(encrypted); } });
  await assert.rejects(readWeixinExternalFile(api, source, { ...event.attachments[0], resourceKey: 'forged' }, { assertCurrent() {} }), { code: 'stale-route' });
  assert.equal(fetches, 0);
  const stream = await readWeixinExternalFile(api, source, event.attachments[0], { assertCurrent() {} });
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  let current = true;
  const revoked = createWeixinApi({ fetchImpl: async () => { current = false; return new Response(encrypted); } });
  await assert.rejects(readWeixinExternalFile(revoked, source, event.attachments[0], { assertCurrent() { if (!current) throw Object.assign(new Error('stale-route'), { code: 'stale-route' }); } }), { code: 'stale-route' });
});

test('raw voice leases are negotiated and private tickets survive restart without entering the event', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { WeixinController } = await import('../../../src/channels/weixin/weixin-controller.mjs');
  const { WeixinConfigStore } = await import('../../../src/channels/weixin/config-store.mjs');
  const { WeixinStateStore } = await import('../../../src/channels/weixin/state-store.mjs');
  const root = await mkdtemp(join(tmpdir(), 'weixin-audio-controller-'));
  const store = await new WeixinConfigStore(join(root, 'config.json')).load(); await store.save(config);
  let receive; let ready = false; let canonical;
  const controller = new WeixinController({ api: { beginLogin() {}, pollLogin() {} }, configStore: store,
    credentials: { resolve: async () => ({ value: 'token' }), set: async () => {}, unset: async () => {} },
    createRuntime: async input => { receive = input.externalConsumer; return { start: async () => { ready = true; }, stop: async () => { ready = false; }, get status() { return { ready }; } }; } });
  try {
    assert.ok((await controller.describeDeliveryAccount(config.botId)).capabilities.includes('source-voice-audio-checked'));
    const statePath = join(root, 'state.json');
    const state = await new WeixinStateStore(statePath).load();
    const dispose = await controller.consumeInbound(config.botId, { expectedFingerprint: account.fingerprint, sourceVoiceAudio: true, onEvent: async event => { canonical = event; return { accepted: true }; } });
    await receive(message, state, new AbortController().signal);
    assert.deepEqual(canonical.attachments, eventOf().attachments);
    const reopened = await new WeixinStateStore(statePath).load();
    assert.equal(reopened.externalReplySource(message.message_id).file.kind, 'voice');
    assert.ok(!JSON.stringify(canonical).includes('private-ticket'));
    dispose();
    await assert.rejects(receive(message, state, new AbortController().signal), { code: 'consumer-unavailable' });
  } finally { await controller.close(); }
});
