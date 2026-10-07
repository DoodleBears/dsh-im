import assert from 'node:assert/strict';
import test from 'node:test';
import { pairedWeixinAccount, normalizeWeixinExternalText } from '../../../src/channels/weixin/external-consumer.mjs';
import { deriveWeixinBotIdentity } from '../../../src/channels/weixin/config-store.mjs';

const config = { ...deriveWeixinBotIdentity('qa.bot'), accountId: 'qa.bot', ownerUserId: 'owner',
  connectedAt: '2026-10-05T00:00:00Z', baseUrl: 'https://ilinkai.weixin.qq.com/' };
const account = pairedWeixinAccount(config, 'token');
const message = { message_type: 1, from_user_id: 'owner', to_user_id: 'qa.bot',
  message_id: '9007199254740993', create_time_ms: 1791158400000, context_token: 'private-context',
  item_list: [{ type: 3, msg_id: 'native-voice', voice_item: { text: '  BH905 voice phrase  ', playtime: 2500,
    media: { aes_key: 'private-key', full_url: 'https://private.example/audio' } } }] };
const normalize = value => normalizeWeixinExternalText(value, { botId: config.botId, account, sourceVoiceTranscripts: true });

test('voice intake is opt-in and preserves platform transcript provenance without exposing audio credentials', () => {
  assert.equal(normalizeWeixinExternalText(message, {botId: config.botId, account, sourceImages: true, sourceFiles: true}), null);
  const event = normalize(message);
  assert.equal(event.text, 'BH905 voice phrase');
  assert.equal(event.messageId, '9007199254740993');
  assert.deepEqual(event.voice, { transcript: 'platform', durationMs: 2500, itemId: 'native-voice' });
  assert.equal(event.attachments, undefined);
  assert.deepEqual(event.reply, { messageId: message.message_id, conversationId: 'owner', actorId: 'owner' });
  for (const secret of ['private-context', 'private-key', 'private.example']) assert.ok(!JSON.stringify(event).includes(secret));
  assert.equal(normalize({...message, from_user_id: 'other'}), null);
  assert.equal(normalize({...message, group_id: 'group'}), null);
});

test('a missing platform transcript is explicit and never replaced by an unrelated caption or invented audio resource', () => {
  const native = { ...message, item_list: [{ type: 3, voice_item: { playtime: 0 } }] };
  const event = normalize(native);
  assert.deepEqual(event.voice, { transcript: 'unavailable', durationMs: 0 });
  assert.match(event.text, /did not provide a transcript/);
  assert.equal(event.attachments, undefined);
  assert.throws(() => normalize({...native, item_list: [...native.item_list, {type: 1, text_item: {text: 'caption is not ASR'}}]}), {code: 'invalid-inbound'});
});

test('malformed, oversized and ambiguous native voice metadata is refused', () => {
  for (const voice of [{text: 1}, {text: 'x'.repeat(16001)}, {text: 'x', playtime: -1}, {text: 'x', playtime: 1.5}, {text: 'x', playtime: Number.MAX_SAFE_INTEGER + 1}]) {
    assert.throws(() => normalize({...message, item_list: [{type: 3, voice_item: voice}]}), {code: 'invalid-inbound'});
  }
  assert.throws(() => normalize({...message, item_list: [...message.item_list, ...message.item_list]}), {code: 'invalid-inbound'});
  assert.throws(() => normalize({...message, to_user_id: 'other.bot'}), {code: 'account-changed'});
  assert.equal(normalize({...message, message_state: 1}), null);
  assert.equal(normalize({...message, item_list: [{...message.item_list[0], is_completed: false}]}), null);
});

test('controller negotiates voice intake and retains only a private original-DM reply continuation', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { WeixinController } = await import('../../../src/channels/weixin/weixin-controller.mjs');
  const { WeixinConfigStore } = await import('../../../src/channels/weixin/config-store.mjs');
  const { WeixinStateStore } = await import('../../../src/channels/weixin/state-store.mjs');
  const root = await mkdtemp(join(tmpdir(), 'weixin-voice-controller-'));
  const store = await new WeixinConfigStore(join(root, 'config.json')).load(); await store.save(config);
  let receive; let ready = false; let canonical;
  const controller = new WeixinController({ api: { beginLogin() {}, pollLogin() {} }, configStore: store,
    credentials: { resolve: async () => ({ value: 'token' }), set: async () => {}, unset: async () => {} },
    createRuntime: async input => { receive = input.externalConsumer; return { start: async () => {ready = true;}, stop: async () => {ready = false;}, get status() {return {ready};} }; } });
  try {
    const info = await controller.describeDeliveryAccount(config.botId);
    assert.ok(info.capabilities.includes('source-voice-transcript-checked'));
    const state = await new WeixinStateStore(join(root, 'state.json')).load();
    const textOnly = await controller.consumeInbound(config.botId, { expectedFingerprint: account.fingerprint,
      onEvent: async () => assert.fail('text-only Consumer must not receive voice') });
    await receive(message, state, new AbortController().signal);
    assert.equal(state.externalReplySource(message.message_id), undefined);
    textOnly();
    const dispose = await controller.consumeInbound(config.botId, { expectedFingerprint: account.fingerprint,
      sourceVoiceTranscripts: true, onEvent: async event => {canonical = event; return {accepted: true};} });
    await receive(message, state, new AbortController().signal);
    assert.deepEqual(canonical.voice, normalize(message).voice);
    assert.equal(state.externalReplySource(message.message_id).contextToken, 'private-context');
    assert.equal(state.externalReplySource(message.message_id).file, undefined);
    dispose();
    await assert.rejects(receive(message, state, new AbortController().signal), {code: 'consumer-unavailable'});
  } finally {await controller.close();}
});
