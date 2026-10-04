import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackRuntime } from '../../../src/channels/slack/slack-runtime.mjs';
import { SlackApi } from '../../../src/channels/slack/slack-api.mjs';
import { ExclusiveInboundConsumers } from '../../../src/channels/shared/exclusive-inbound-consumers.mjs';
import { normalizeSlackExternalText, verifiedSlackAccount } from '../../../src/channels/slack/external-consumer.mjs';
import { SlackController } from '../../../src/channels/slack/slack-controller.mjs';
import { SlackConfigStore, deriveSlackBotIdentity } from '../../../src/channels/slack/config-store.mjs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const identity = { team_id: 'T12345678', user_id: 'U12345678', bot_id: 'B12345678' };
const bot = { id: identity.bot_id, user_id: identity.user_id, app_id: 'A12345678', name: 'QA Bot' };
const account = verifiedSlackAccount(identity, bot);
const botId = 'slack_0123456789abcdef01234567';

test('read API queries reach Slack as form parameters for identity and exact thread source checks', async () => {
  const childTs = '1791127736.123456';
  const rootTs = '1791127600.000001';
  const api = new SlackApi({ botToken: 'xoxb-test-1234567890123456', fetchImpl: async (url, request) => {
    assert.match(request.headers['content-type'], /^application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(request.body);
    const method = new URL(url).pathname.split('/').at(-1);
    if (method === 'bots.info') {
      assert.equal(form.get('bot'), bot.id);
      return Response.json({ ok: true, bot });
    }
    if (method === 'users.info') {
      assert.equal(form.get('user'), identity.user_id);
      return Response.json({ ok: true, user: { id: identity.user_id } });
    }
    assert.equal(form.get('channel'), 'C12345678');
    if (method === 'conversations.info') return Response.json({ ok: true, channel: { id: 'C12345678', is_member: true } });
    assert.equal(form.get('oldest'), childTs);
    assert.equal(form.get('latest'), childTs);
    assert.equal(form.get('inclusive'), 'true');
    if (method === 'conversations.replies') assert.equal(form.get('ts'), rootTs);
    return Response.json({ ok: true, messages: [{ ts: childTs, user: identity.user_id, thread_ts: rootTs }] });
  } });
  assert.equal((await api.botInfo({ botId: bot.id })).app_id, bot.app_id);
  assert.equal((await api.userInfo({ userId: identity.user_id })).id, identity.user_id);
  assert.equal((await api.conversationInfo({ channelId: 'C12345678' })).is_member, true);
  assert.equal((await api.getMessage({ channelId: 'C12345678', messageTs: childTs })).ts, childTs);
  assert.equal((await api.threadMessage({ channelId: 'C12345678', threadTs: rootTs, messageTs: childTs })).ts, childTs);
});
function payload(overrides = {}) {
  return { type: 'event_callback', api_app_id: bot.app_id, team_id: identity.team_id,
    event_id: 'Ev12345678', event: { type: 'app_mention', channel: 'C12345678', user: 'U87654321',
      ts: '1791127736.123456', text: `<@${identity.user_id}> Test`, ...overrides } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
class Socket {
  readyState = 1;
  listeners = new Map();
  sent = [];
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  packet(value) { this.listeners.get('message')?.({ data: JSON.stringify(value) }); }
}
async function fixture(onEvent, overrides = {}) {
  let socket;
  const sends = [];
  let sessionWrites = 0;
  const source = { ...payload().event };
  const api = {
    authTest: async () => identity, botInfo: async () => bot,
    openConnection: async () => ({ url: 'wss://wss-primary.slack.com/link/?ticket=test' }),
    conversationInfo: async () => ({ id: source.channel, is_member: true, name: 'qa' }),
    userInfo: async () => ({ id: source.user, real_name: 'QA Human' }),
    getMessage: async () => source,
    threadMessage: async () => source,
    postMessage: async request => { sends.push(request); return { channel: source.channel, ts: '1791127737.000001' }; },
    ...overrides,
  };
  const runtime = new SlackRuntime({ config: { botId, platformId: `${identity.team_id}:${identity.user_id}`, consumerMode: 'external-consumer' },
    botToken: 'xoxb-test-1234567890123456', appToken: 'xapp-test-1234567890123456',
    harness: { ensureRunning: async () => true }, state: { setSession: () => { sessionWrites++; } },
    externalConsumer: onEvent, createApi: () => api, createWebSocket: () => {
      socket = new Socket(); queueMicrotask(() => socket.packet({ type: 'hello', connection_info: { app_id: bot.app_id } }));
      return socket;
    }, logger: { warn() {}, error() {}, info() {}, debug() {} }, connectTimeoutMs: 100,
  });
  await runtime.start();
  return { runtime, socket, sends, source, sessionWrites: () => sessionWrites };
}

test('native Slack message/channel/thread IDs are preserved independently of delivery event ID', () => {
  const root = normalizeSlackExternalText(payload(), { botId, account });
  assert.equal(root.messageId, '1791127736.123456');
  assert.equal(root.eventId, 'Ev12345678');
  assert.equal(root.conversation.id, 'C12345678');
  assert.equal(root.reply.threadId, root.messageId);
  assert.equal(root.reply.parentId, undefined);
  const child = normalizeSlackExternalText(payload({ thread_ts: '1791127600.000001' }), { botId, account });
  assert.equal(child.reply.rootId, '1791127600.000001');
  assert.equal(child.reply.threadId, child.reply.rootId);
  assert.throws(() => normalizeSlackExternalText({ ...payload(), team_id: 'T00000000' }, { botId, account }), { code: 'account-changed' });
  assert.throws(() => verifiedSlackAccount(identity, { ...bot, user_id: 'U00000000' }), { code: 'account-unverified' });
  assert.equal(normalizeSlackExternalText(payload({ text: 'ordinary' }), { botId, account }), null);
  assert.equal(normalizeSlackExternalText(payload({ bot_id: bot.id }), { botId, account }), null);
});

test('Socket Mode ack waits for canonical acceptance and never creates a standalone Session', async () => {
  let accept;
  let received;
  const f = await fixture(async event => { received = event; return new Promise(resolve => { accept = resolve; }); });
  try {
    f.socket.packet({ type: 'events_api', envelope_id: 'env-1', payload: payload() });
    await flush();
    assert.equal(received.actor.name, 'QA Human');
    assert.equal(f.socket.sent.length, 0);
    accept({ accepted: true }); await flush();
    assert.deepEqual(f.socket.sent, [{ envelope_id: 'env-1' }]);
    assert.equal(f.sessionWrites(), 0);
  } finally { await f.runtime.stop(); }
});

test('disposed exclusive lease refuses redelivery without ack or fallback', async () => {
  const consumers = new ExclusiveInboundConsumers();
  let handled = 0;
  const dispose = consumers.register(botId, { fingerprint: account.fingerprint,
    onEvent: async () => { handled++; return { accepted: true }; } });
  const f = await fixture((event, signal) => consumers.accept(botId, event, signal));
  try {
    dispose();
    f.socket.packet({ type: 'events_api', envelope_id: 'env-2', payload: payload() }); await flush();
    assert.equal(handled, 0); assert.equal(f.socket.sent.length, 0); assert.equal(f.sessionWrites(), 0);
  } finally { await f.runtime.stop(); }
});

test('native reply verifies exact source and fence, emits one thread send with receipt and no retry', async () => {
  const f = await fixture(async () => ({ accepted: true }));
  try {
    const route = normalizeSlackExternalText(payload(), { botId, account }).reply;
    await assert.rejects(f.runtime.replyChecked(route, 'no', { beforeSend: () => false }), { code: 'stale-route' });
    assert.equal(f.sends.length, 0);
    const result = await f.runtime.replyChecked(route, 'yes', { receipt: true, beforeSend: () => true });
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].threadTs, route.threadId); assert.equal(f.sends[0].retry, false);
    assert.deepEqual(result.receipt, { version: 1, messageId: '1791127737.000001', conversationId: route.conversationId });
    f.source.user = 'U11111111';
    await assert.rejects(f.runtime.replyChecked(route, 'no'), { code: 'stale-route' });
    assert.equal(f.sends.length, 1);
  } finally { await f.runtime.stop(); }
});

test('ambiguous Slack send failure is never treated as safely retryable', async () => {
  const f = await fixture(async () => ({ accepted: true }), { postMessage: async () => { throw new Error('transport lost after send'); } });
  try {
    const route = normalizeSlackExternalText(payload(), { botId, account }).reply;
    await assert.rejects(f.runtime.replyChecked(route, 'yes'), { code: 'reply-result-unknown' });
  } finally { await f.runtime.stop(); }
});

test('controller persists exclusive mode across lease disposal and rejects a second consumer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-slack-consumer-'));
  const configPath = join(directory, 'config.json');
  const store = await new SlackConfigStore(configPath).load();
  const platformId = `${identity.team_id}:${identity.user_id}`;
  const refs = deriveSlackBotIdentity(platformId);
  await store.save({ ...refs, platformId, name: 'QA' });
  let externalConsumer;
  let starts = 0;
  let receives = 0;
  const controller = new SlackController({
    configStore: store,
    credentials: { resolve: async () => ({ value: 'private-local-token' }), set() {}, unset() {} },
    createApi: () => ({ authTest: async () => identity, botInfo: async () => bot }),
    createRuntime: async input => {
      externalConsumer = input.externalConsumer;
      return { status: { ready: true }, start: async () => { starts++; }, stop: async () => {} };
    }, logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    await controller.initialize();
    const verified = await controller.describeDeliveryAccount(refs.botId);
    assert.equal(verified.account.fingerprint, account.fingerprint);
    const dispose = await controller.consumeInbound(refs.botId, { expectedFingerprint: account.fingerprint,
      onEvent: async () => { receives++; return { accepted: true }; } });
    assert.equal(starts, 2);
    const evidence = normalizeSlackExternalText(payload(), { botId: refs.botId, account });
    await externalConsumer(evidence);
    assert.equal(receives, 1);
    await assert.rejects(controller.consumeInbound(refs.botId, {
      expectedFingerprint: account.fingerprint, onEvent: async () => ({ accepted: true }),
    }), { code: 'consumer-conflict' });
    assert.equal(starts, 2);
    dispose();
    await assert.rejects(externalConsumer(evidence), { code: 'consumer-unavailable' });
    assert.equal((await new SlackConfigStore(configPath).load()).get(refs.botId).consumerMode, 'external-consumer');
    const document = JSON.parse(await readFile(configPath, 'utf8'));
    document.bots[0].consumerMode = 'invalid-mode';
    await writeFile(configPath, JSON.stringify(document));
    await assert.rejects(new SlackConfigStore(configPath).load(), /invalid bot data/);
  } finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
});

test('verified reply to a child stays in the root thread and channel removal prevents sending', async () => {
  let member = true;
  const f = await fixture(async () => ({ accepted: true }), {
    conversationInfo: async () => ({ id: 'C12345678', is_member: member }),
  });
  try {
    f.source.thread_ts = '1791127600.000001';
    const route = normalizeSlackExternalText(payload({ thread_ts: f.source.thread_ts }), { botId, account }).reply;
    await f.runtime.replyChecked(route, 'thread reply');
    assert.equal(f.sends[0].threadTs, f.source.thread_ts);
    member = false;
    await assert.rejects(f.runtime.replyChecked(route, 'no'), { code: 'reply-permission-denied' });
    assert.equal(f.sends.length, 1);
  } finally { await f.runtime.stop(); }
});
