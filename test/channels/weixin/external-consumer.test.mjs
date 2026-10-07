import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveWeixinBotIdentity } from '../../../src/channels/weixin/config-store.mjs';
import { pairedWeixinAccount, normalizeWeixinExternalText, checkedWeixinRoute } from '../../../src/channels/weixin/external-consumer.mjs';
import { WeixinRuntime } from '../../../src/channels/weixin/weixin-runtime.mjs';
import { WeixinStateStore } from '../../../src/channels/weixin/state-store.mjs';
const config = { ...deriveWeixinBotIdentity('qa.bot'), accountId: 'qa.bot', ownerUserId: 'owner',
  connectedAt: '2026-10-05T00:00:00Z', baseUrl: 'https://ilinkai.weixin.qq.com/', consumerMode: 'external-consumer' };
const account = pairedWeixinAccount(config, 'token');
const message = { message_type: 1, from_user_id: 'owner', to_user_id: 'qa.bot',
  message_id: '9007199254740993', create_time_ms: 1791158400000, context_token: 'private-context',
  item_list: [{ type: 1, text_item: { text: 'QA inbound' } }] };

test('paired-owner DM preserves native ID but never leaks the private continuation or fabricates a topic', () => {
  const event = normalizeWeixinExternalText(message, { botId: config.botId, account });
  assert.equal(event.messageId, '9007199254740993');
  assert.deepEqual(event.conversation, { kind: 'dm', id: 'owner' });
  assert.equal(event.mentionedAccount, false);
  assert.deepEqual(event.reply, { messageId: event.messageId, conversationId: 'owner', actorId: 'owner' });
  assert.ok(!JSON.stringify(event).includes('private-context'));
  assert.equal(normalizeWeixinExternalText({ ...message, from_user_id: 'stranger' }, { botId: config.botId, account }), null);
  assert.equal(normalizeWeixinExternalText({ ...message, message_type: 2 }, { botId: config.botId, account }), null);
  assert.equal(normalizeWeixinExternalText({ ...message, item_list: [{ type: 2 }] }, { botId: config.botId, account }), null);
  assert.throws(() => normalizeWeixinExternalText({ ...message, to_user_id: 'other.bot' }, { botId: config.botId, account }), { code: 'account-changed' });
  assert.throws(() => normalizeWeixinExternalText({ ...message, message_id: Number(message.message_id) }, { botId: config.botId, account }), { code: 'invalid-inbound' });
});

test('credential rotation changes the fingerprint and stale or forged reply routes are refused', () => {
  assert.notEqual(account.fingerprint, pairedWeixinAccount(config, 'other-token').fingerprint);
  const event = normalizeWeixinExternalText(message, { botId: config.botId, account });
  const source = { messageId: event.messageId, actorId: 'owner', fingerprint: account.fingerprint,
    contextToken: 'private-context', expiresAt: Date.now() + 10000 };
  assert.deepEqual(checkedWeixinRoute(event.reply, account, source), event.reply);
  for (const route of [{ ...event.reply, threadId: 'fake' }, { ...event.reply, actorId: 'stranger' }, { ...event.reply, messageId: '123' }])
    assert.throws(() => checkedWeixinRoute(route, account, source), { code: 'stale-route' });
  assert.throws(() => checkedWeixinRoute(event.reply, account, { ...source, expiresAt: 1 }), { code: 'stale-route' });
});

test('external cursor waits for durable consumer acceptance and never creates a Harness Session', async () => {
  let accept;
  let entered;
  const observed = new Promise(resolve => { entered = resolve; });
  const accepted = new Promise(resolve => { accept = resolve; });
  let cursor = '';
  let polls = 0;
  const runtime = new WeixinRuntime({ config, token: 'token', harness: {
    ensureRunning: async () => {}, ask: async () => assert.fail('external mode must not open a Session'),
  }, state: { getUpdatesBuf: () => cursor, setGetUpdatesBuf: async value => { cursor = value; } },
    api: { notifyStart: async () => {}, notifyStop: async () => {}, getUpdates: async ({ signal }) => {
      if (++polls === 1) return { ret: 0, msgs: [message], get_updates_buf: 'next' };
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }, externalConsumer: async () => { entered(); await accepted; } });
  await runtime.start(); await observed;
  assert.equal(cursor, ''); accept();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cursor, 'next');
  await runtime.stop();
});

test('source continuation survives a state reload and checked send returns an honest client acknowledgement', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'wechat-source-')), 'state.json');
  const state = await new WeixinStateStore(path).load();
  const event = normalizeWeixinExternalText(message, { botId: config.botId, account });
  await state.rememberExternalReplySource({ messageId: event.messageId, actorId: 'owner', fingerprint: account.fingerprint,
    contextToken: 'private-context', expiresAt: Date.now() + 10000 });
  const restored = await new WeixinStateStore(path).load();
  assert.ok(!JSON.stringify(restored.snapshot()).includes('private-context'));
  assert.equal(restored.snapshot().externalReplySources, undefined);
  let calls = 0;
  const runtime = new WeixinRuntime({ config, token: 'token', state: restored, harness: {}, api: {
    sendText: async input => { ++calls; assert.equal(input.toUserId, 'owner'); assert.equal(input.contextToken, 'private-context');
      return { providerMessageIds: ['dsh-weixin-local-id'] }; }
  } });
  await assert.rejects(runtime.replyChecked(event.reply, 'QA reply', { account, beforeSend: () => false }), { code: 'stale-route' });
  assert.equal(calls, 0);
  const result = await runtime.replyChecked(event.reply, 'QA reply', { account, receipt: true });
  assert.deepEqual(result.receipt, { version: 1, messageId: 'dsh-weixin-local-id', conversationId: 'owner', identityKind: 'client-acknowledgement' });
});


test('controller releases its transition before callbacks, and consumer disposal stays external across restart', async () => {
  const { WeixinController } = await import('../../../src/channels/weixin/weixin-controller.mjs');
  const { WeixinConfigStore } = await import('../../../src/channels/weixin/config-store.mjs');
  const root = await mkdtemp(join(tmpdir(), 'wechat-controller-'));
  const store = await new WeixinConfigStore(join(root, 'config.json')).load();
  await store.save({ ...config, consumerMode: undefined });
  let callback;
  let ready = false;
  const controller = new WeixinController({ api: { beginLogin() {}, pollLogin() {} },
    configStore: store, credentials: { resolve: async () => ({ value: 'token' }), set: async () => {}, unset: async () => {} },
    createRuntime: async input => {
      callback = input.externalConsumer;
      return { start: async () => { ready = true; }, stop: async () => { ready = false; },
        get status() { return { ready }; }, qualifyReplyChecked: async route => route };
    } });
  const described = await controller.describeDeliveryAccount(config.botId);
  const state = await new WeixinStateStore(join(root, 'state.json')).load();
  const dispose = await controller.consumeInbound(config.botId, { expectedFingerprint: described.account.fingerprint,
    onEvent: async event => {
      assert.deepEqual(await controller.qualifyReplyChecked(config.botId, event.reply, { expectedFingerprint: account.fingerprint }), event.reply);
      return { accepted: true };
    } });
  await callback(message, state, new AbortController().signal);
  dispose();
  await assert.rejects(callback(message, state, new AbortController().signal), { code: 'consumer-unavailable' });
  const reloaded = await new WeixinConfigStore(join(root, 'config.json')).load();
  assert.equal(reloaded.get(config.botId).consumerMode, 'external-consumer');
  await controller.close();
});

test('native quote opt-in preserves server/item IDs, embedded body, summary and partial evidence without media secrets', () => {
  const ref = { svr_id: '18446744073709551615', title: 'display summary',
    message_item: { type: 1, msg_id: 'v1:18446744073709551614', text_item: { text: 'actual original' },
      ref_msg: { title: 'nested quote is not copied' }, context_token: 'private' },
    partial_text: { start: 'actual', end: 'original', startindex: 0, endindex: 15, quotemd5: 'native-digest' } };
  const native = { ...message, item_list: [{ type: 1, text_item: { text: 'follow up' }, ref_msg: ref }] };
  assert.equal(normalizeWeixinExternalText(native, { botId: config.botId, account }).quote, undefined);
  const event = normalizeWeixinExternalText(native, { botId: config.botId, account, sourceQuotes: true });
  assert.deepEqual(event.quote, { serverMessageId: ref.svr_id, itemId: ref.message_item.msg_id,
    text: 'actual original', summary: 'display summary', partial: { start: 'actual', end: 'original', startIndex: 0, endIndex: 15, digest: 'native-digest' } });
  assert.ok(!JSON.stringify(event).includes('private'));
  assert.equal(event.reply.threadId, undefined);
  assert.throws(() => normalizeWeixinExternalText({ ...native, item_list: [{ ...native.item_list[0], ref_msg: { svr_id: Number(ref.svr_id) } }] },
    { botId: config.botId, account, sourceQuotes: true }), { code: 'invalid-inbound' });
  const only = normalizeWeixinExternalText({ ...native, item_list: [{ ...native.item_list[0], ref_msg: { svr_id: ref.svr_id, title: 'summary only' } }] },
    { botId: config.botId, account, sourceQuotes: true });
  assert.equal(only.quote.text, undefined);
  assert.equal(only.quote.summary, 'summary only');
});
