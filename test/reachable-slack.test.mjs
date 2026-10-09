import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackController } from '../src/channels/slack/slack-controller.mjs';
import { SlackApi } from '../src/channels/slack/slack-api.mjs';
import { SlackRuntime } from '../src/channels/slack/slack-runtime.mjs';
import { SlackConfigStore, deriveSlackBotIdentity } from '../src/channels/slack/config-store.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';

const identity = { team_id: 'T12345678', user_id: 'U12345678', bot_id: 'B12345678' };
const bot = { id: identity.bot_id, user_id: identity.user_id, app_id: 'A12345678' };
const channelId = 'C12345678';
const logger = { info() {}, warn() {}, error() {}, debug() {} };
class Socket {
  listeners = new Map(); readyState = 1;
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  packet(value) { this.listeners.get('message')?.({ data: JSON.stringify(value) }); }
  send() {}
  close() { this.readyState = 3; }
}
async function fixture(t, nativeHttp = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-reachable-slack-'));
  const store = await new SlackConfigStore(join(directory, 'config.json')).load();
  const platformId = `${identity.team_id}:${identity.user_id}`;
  const refs = deriveSlackBotIdentity(platformId);
  await store.save({ ...refs, platformId, name: 'Test bot', consumerMode: 'external-consumer' });
  const sends = [];
  const channel = { id: channelId, name: 'qa', is_member: true, is_channel: true, is_archived: false };
  const privateChannel = { ...channel, id: 'G12345678', name: 'private-qa', is_private: true, is_channel: false, is_group: true };
  const api = {
    authTest: async () => identity, botInfo: async () => bot,
    openConnection: async () => ({ url: 'wss://wss-primary.slack.com/link' }),
    hasBotScope: scope => scope === 'chat:write',
    joinedConversations: async () => ({ channels: [channel, privateChannel], response_metadata: { next_cursor: '' } }),
    conversationInfo: async ({ channelId: id }) => id === channelId ? channel : privateChannel,
    postMessage: async input => { sends.push(input); return { channel: input.channelId, ts: '1791557737.000001' }; },
  };
  const createApi = nativeHttp ? () => new SlackApi({ botToken: 'xoxb-test-1234567890123456',
    appToken: 'xapp-test-1234567890123456', fetchImpl: async (url, request) => {
      const method = new URL(url).pathname.split('/').at(-1);
      let result;
      if (method === 'auth.test') result = await api.authTest();
      else if (method === 'bots.info') result = { bot: await api.botInfo() };
      else if (method === 'apps.connections.open') result = await api.openConnection();
      else if (method === 'users.conversations') {
        assert.match(request.headers['content-type'], /^application\/x-www-form-urlencoded/);
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('types'), 'public_channel,private_channel');
        assert.equal(form.get('exclude_archived'), 'true');
        const page = await api.joinedConversations();
        result = { ...page, channels: page.channels.map(({ is_member, ...channel }) => channel) };
      } else if (method === 'conversations.info') {
        const form = new URLSearchParams(request.body);
        result = { channel: await api.conversationInfo({ channelId: form.get('channel') }) };
      } else {
        assert.equal(method, 'chat.postMessage');
        const body = JSON.parse(request.body);
        assert.equal(body.thread_ts, undefined);
        result = await api.postMessage({ channelId: body.channel, text: body.text });
      }
      return Response.json({ ok: true, ...result }, { headers: { 'x-oauth-scopes': 'chat:write,channels:read,groups:read' } });
    } }) : () => api;
  const controller = new SlackController({ configStore: store, logger,
    credentials: { resolve: async () => ({ value: 'test-only' }), set() {}, unset() {} }, createApi,
    createRuntime: async options => new SlackRuntime({ ...options, harness: { ensureRunning: async () => {} }, state: {},
      logger, createApi, connectTimeoutMs: 500,
      createWebSocket: () => { const socket = new Socket(); queueMicrotask(() => socket.packet({ type: 'hello', connection_info: { app_id: bot.app_id } })); return socket; } }),
  });
  t.after(async () => { await controller.close(); await rm(directory, { recursive: true, force: true }); });
  await controller.initialize();
  const service = createDeliveryService();
  service.registerAdapter(createDeliveryAdapter({ channel: 'slack', coreController: controller,
    workspaces: { has: id => id === refs.botId, listBotIds: () => [refs.botId], listDeliveryTargets: () => [] },
    stateFor: async () => ({ snapshot: () => ({ sessions: {} }) }) }));
  const described = await service.describeBot(refs.botId);
  return { service, controller, botId: refs.botId, api, channel, privateChannel, sends,
    options: { expectedFingerprint: described.account.fingerprint, beforeSend: () => true } };
}

test('public Slack first post discovers only joined writable groups and retains the native receipt without a saved target', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.listReachableConversations(f.botId, f.options), {
    version: 1, conversations: [{ id: channelId, kind: 'group', name: '#qa' },
      { id: 'G12345678', kind: 'group', name: '#private-qa' }], hasMore: false,
  });
  assert.deepEqual(await f.service.postConversationChecked(f.botId, 'G12345678', 'First post', f.options), {
    sent: true, receipt: { version: 1, messageId: '1791557737.000001', conversationId: 'G12345678' },
  });
  assert.deepEqual((await f.service.listTargets(f.botId)).targets, []);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].threadTs, undefined);
  assert.equal(f.sends[0].retry, false);
});

test('Slack public group operations authenticate Bot scopes and use conversations.info when membership is omitted from discovery', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.service.listReachableConversations(f.botId, f.options)).conversations.length, 2);
  assert.equal((await f.service.postConversationChecked(f.botId, channelId, 'Native HTTP first post', f.options)).receipt.messageId, '1791557737.000001');
  assert.equal(f.sends.length, 1);
});

test('Slack native dispatch observes current authorization even when revocation is queued at the final fence', async t => {
  const f = await fixture(t);
  let permissionRead = false;
  let allowed = true;
  const authorizationAtDispatch = [];
  f.api.conversationInfo = async () => { permissionRead = true; return f.channel; };
  f.api.postMessage = async input => {
    authorizationAtDispatch.push(allowed);
    return { channel: input.channelId, ts: '1791557737.000001' };
  };
  await f.service.postConversationChecked(f.botId, channelId, 'Final authorization race', {
    ...f.options, beforeSend: () => {
      if (permissionRead) queueMicrotask(() => { allowed = false; });
      return allowed;
    },
  });
  assert.deepEqual(authorizationAtDispatch, [true]);
});

test('Slack membership and write restrictions are rechecked before the final fence; ambiguous sends are not retried', async t => {
  const f = await fixture(t);
  await f.service.listReachableConversations(f.botId, f.options);
  f.channel.is_member = false;
  await assert.rejects(f.service.postConversationChecked(f.botId, channelId, 'Removed', f.options), { code: 'send-permission-denied' });
  f.channel.is_member = true;
  f.channel.properties = { posting_restricted_to: { type: ['admin'] } };
  await assert.rejects(f.service.postConversationChecked(f.botId, channelId, 'Restricted', f.options), { code: 'send-permission-denied' });
  delete f.channel.properties;
  f.api.hasBotScope = () => false;
  await assert.rejects(f.service.postConversationChecked(f.botId, channelId, 'Scope revoked', f.options), { code: 'send-permission-denied' });
  f.api.hasBotScope = () => true;
  let current = true;
  f.api.conversationInfo = async () => { current = false; return f.channel; };
  await assert.rejects(f.service.postConversationChecked(f.botId, channelId, 'Final fence', {
    ...f.options, beforeSend: () => current,
  }), { code: 'send-permission-denied' });
  assert.equal(f.sends.length, 0);
  f.api.postMessage = async input => { f.sends.push(input); throw new Error('Lost result'); };
  await assert.rejects(f.service.postConversationChecked(f.botId, channelId, 'Unknown', f.options), { code: 'send-result-unknown' });
  assert.equal(f.sends.length, 1);
});

test('Slack cursor pages omit removed groups and Provider closure fences a pending permission lookup', async t => {
  const f = await fixture(t);
  f.api.joinedConversations = async ({ cursor }) => cursor
    ? { channels: [f.privateChannel], response_metadata: { next_cursor: '' } }
    : { channels: [f.channel], response_metadata: { next_cursor: 'next-page' } };
  const first = await f.service.listReachableConversations(f.botId, f.options);
  assert.equal(first.cursor, 'next-page');
  assert.deepEqual((await f.service.listReachableConversations(f.botId, { ...f.options, cursor: first.cursor })).conversations,
    [{ id: 'G12345678', kind: 'group', name: '#private-qa' }]);
  let enter; let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const lookup = new Promise(resolve => { release = resolve; });
  f.api.conversationInfo = async () => { enter(); await lookup; return f.channel; };
  const posted = f.service.postConversationChecked(f.botId, channelId, 'Must not send', f.options);
  await entered;
  const closed = f.controller.close(); release();
  await assert.rejects(posted, { code: 'provider-unavailable' });
  await closed;
  assert.equal(f.sends.length, 0);
});
