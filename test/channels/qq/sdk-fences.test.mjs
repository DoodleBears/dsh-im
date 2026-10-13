import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { QqExternalConsumer, verifiedQqAccount } from '../../../src/channels/qq/external-consumer.mjs';
import { QqRuntime } from '../../../src/channels/qq/qq-runtime.mjs';
import { createHash } from 'node:crypto';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('pinned SDK pre-dispatch Logger exposes metadata even when native normalization refuses the frame', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  let socket;
  let sdkLogger;
  const records = [];
  const admitted = [];
  server.on('connection', client => {
    socket = client;
    client.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    client.on('message', bytes => {
      const value = JSON.parse(bytes.toString());
      if (value.op === 2) client.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'fake-session' } }));
    });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    return json(path.includes('getAppAccessToken') ? { access_token: 'fake-token', expires_in: 7200 }
      : path === '/gateway' ? { url: `ws://127.0.0.1:${server.address().port}` }
        : { id: 'native-bot', bot: true });
  };
  const runtime = new QqRuntime({
    config: { botId: 'qa', appId: '12345678', consumerMode: 'external-consumer' },
    appSecret: 'fake-secret', state: {}, harness: {}, externalConsumer: async value => { admitted.push(value); return { accepted: true }; },
    logger: { info: (_label, value) => { if (value?.event === 'qq.native-gateway.frame') records.push(value); }, error() {}, warn() {} },
    createBot: options => { sdkLogger = options.logger; return new QQBot(options); }, connectTimeoutMs: 5000,
  });
  t.after(async () => {
    await runtime.stop();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = originalFetch;
  });
  await runtime.start();
  socket.send(JSON.stringify({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2,
    d: { id: 'private-wire-id', group_openid: 'private-group', author: null, content: 'private-body', authorization: 'private-credential' } }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(records.length, 1);
  assert.equal(records[0].eventType, 'GROUP_MESSAGE_CREATE');
  assert.equal(records[0].messageHash, createHash('sha256').update('private-wire-id').digest('hex'));
  assert.equal(records[0].conversationHash, createHash('sha256').update('private-group').digest('hex'));
  assert.equal(records[0].senderBotFlag, 'absent');
  assert.equal(admitted.length, 0);
  for (const secret of ['private-wire-id', 'private-group', 'private-body', 'private-credential', 'fake-token', 'fake-secret'])
    assert.equal(JSON.stringify(records).includes(secret), false);
  await runtime.stop();
  sdkLogger.debug('[qa] Dispatch event: t=GROUP_MESSAGE_CREATE payload=' + JSON.stringify({ id: 'late-id', group_openid: 'private-group' }));
  assert.equal(records.length, 1);
});

test('actual QQ SDK never posts a message when the consumer is revoked during token acquisition', async t => {
  const tokenStarted = deferred();
  const tokenResponse = deferred();
  const posts = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('getAppAccessToken')) {
      tokenStarted.resolve();
      await tokenResponse.promise;
      return json({ access_token: 'fake-token', expires_in: 7200 });
    }
    posts.push({ url: String(url), body: JSON.parse(options.body) });
    return json({ id: 'native-receipt' });
  };
  const bot = new QQBot({ appId: '12345678', appSecret: 'fake-secret' });
  const abort = new AbortController();
  const consumer = new QqExternalConsumer({ bot, botId: 'qa',
    account: verifiedQqAccount('12345678', { id: 'native-bot', bot: true }),
    accept: async () => ({ accepted: true }),
  });
  const route = { messageId: 'native-source', conversationId: 'app-group', actorId: 'member' };
  await consumer.accept({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    senderId: 'member', content: 'question', timestamp: new Date().toISOString(),
    messageId: route.messageId, groupOpenid: route.conversationId,
    replyTarget: { scope: 'group', targetId: route.conversationId, msgId: route.messageId },
  }, abort.signal);
  const reply = consumer.reply(route, 'answer', { signal: abort.signal, receipt: true, beforeSend: () => true });
  const refused = assert.rejects(reply, { code: 'cancelled' });
  await tokenStarted.promise;
  abort.abort();
  tokenResponse.resolve();
  await refused;
  assert.deepEqual(posts, []);
});

test('actual QQ SDK disconnect clears receiver readiness and a native resumed event restores it', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}`;
  let socket;
  let connections = 0;
  server.on('connection', current => {
    socket = current;
    connections++;
    current.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
    current.on('message', bytes => {
      const { op } = JSON.parse(bytes.toString());
      if (op === 2 || op === 6) current.send(JSON.stringify({ op: 0, s: connections,
        t: op === 6 ? 'RESUMED' : 'READY', d: { session_id: 'test-session', user: { id: 'native-bot', bot: true } },
      }));
    });
  });
  const originalFetch = globalThis.fetch;
  let rejectAccountQuery = false;
  globalThis.fetch = async target => String(target).includes('getAppAccessToken')
    ? json({ access_token: 'fake-token', expires_in: 7200 })
    : String(target).endsWith('/gateway') ? json({ url })
      : rejectAccountQuery ? new Response(JSON.stringify({ code: 11253, message: 'private provider text' }),
        { status: 403, headers: { 'content-type': 'application/json' } }) : json({ id: 'native-bot' });
  let disconnected = deferred();
  let bot;
  const runtime = new QqRuntime({
    config: { botId: 'qa', appId: '12345678', consumerMode: 'external-consumer' },
    appSecret: 'fake-secret', state: {}, harness: {}, externalConsumer: async () => ({ accepted: true }),
    logger: { info: text => { if (text.includes('"event":"receiver-state"') && text.includes('"phase":"connecting"')) disconnected.resolve(); }, error() {}, warn() {} },
    createBot: options => { bot = new QQBot(options); return bot; }, connectTimeoutMs: 5000,
  });
  t.after(async () => {
    await runtime.stop();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = originalFetch;
  });
  await runtime.start();
  assert.equal(runtime.status.ready, true);
  rejectAccountQuery = true;
  await assert.rejects(() => runtime.describeDeliveryAccount());
  assert.equal(runtime.status.error.details.httpStatus, 403);
  assert.equal(runtime.status.error.details.providerCode, '11253');
  assert.equal(runtime.status.error.details.stage, 'credential.verify');
  assert.equal(JSON.stringify(runtime.status.error).includes('private provider text'), false);
  rejectAccountQuery = false;
  assert.equal((await runtime.describeDeliveryAccount()).userId, 'native-bot');
  assert.equal(runtime.status.error, null);
  assert.equal(runtime.status.lastError, null);
  for (const mode of ['reconnect', 'normal-close']) {
    disconnected = deferred();
    const resumed = mode === 'reconnect' ? new Promise(resolve => bot.on('resumed', resolve)) : undefined;
    if (mode === 'reconnect') socket.send(JSON.stringify({ op: 7 }));
    else socket.close(1000);
    await disconnected.promise;
    assert.equal(runtime.status.ready, false);
    await assert.rejects(() => runtime.describeDeliveryAccount(), { code: 'bot-not-connected' });
    if (resumed) {
      await resumed;
      assert.equal(runtime.status.ready, true);
      assert.equal((await runtime.describeDeliveryAccount()).userId, 'native-bot');
    }
  }
});
