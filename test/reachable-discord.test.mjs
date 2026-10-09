import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordController } from '../src/channels/discord/discord-controller.mjs';
import { DiscordApi } from '../src/channels/discord/discord-api.mjs';
import { DiscordRuntime } from '../src/channels/discord/discord-runtime.mjs';
import { DiscordConfigStore } from '../src/channels/discord/config-store.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';

const bot = '111111111111111111';
const app = '222222222222222222';
const guildId = '333333333333333333';
const channelId = '444444444444444444';
const otherId = '555555555555555555';
const sentId = '999999999999999999';
const logger = { warn() {}, error() {}, info() {} };
class Socket {
  listeners = new Map(); readyState = 1;
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  packet(value) { this.listeners.get('message')?.({ data: JSON.stringify(value) }); }
  send(raw) {
    if (JSON.parse(raw).op === 2) queueMicrotask(() => this.packet({ op: 0, t: 'READY', s: 1,
      d: { application: { id: app }, user: { id: bot, bot: true }, session_id: 'test-gateway' } }));
  }
  close() { this.readyState = 3; }
}
async function fixture(t, nativeHttp = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-reachable-discord-'));
  const store = await new DiscordConfigStore(join(directory, 'config.json'), { consumerMode: 'external-consumer' }).load();
  const secrets = new Map(); const sends = [];
  const guild = { id: guildId, name: 'Test server', owner_id: otherId,
    roles: [{ id: guildId, permissions: String((1n << 10n) | (1n << 11n)) }] };
  const channel = { id: channelId, guild_id: guildId, name: 'qa', type: 0, permission_overwrites: [] };
  const member = { user: { id: bot }, roles: [] };
  const api = {
    getCurrentUser: async () => ({ id: bot, bot: true }),
    getCurrentApplication: async () => ({ id: app, bot: { id: bot } }),
    getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
    getCurrentGuilds: async ({ after }) => after === guildId ? [] : [{ id: guildId }],
    getGuildChannels: async () => [channel,
      { ...channel, id: otherId, name: 'read-only', permission_overwrites: [{ id: bot, type: 1, deny: '2048', allow: '0' }] }],
    getGuild: async () => guild, getGuildMember: async () => member,
    getChannel: async ({ channelId: id }) => id === channelId ? channel : { ...channel, id, type: 2 },
    createMessage: async input => { sends.push(input); return { id: sentId, channel_id: input.channelId, author: { id: bot, bot: true } }; },
  };
  const token = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(30)}`;
  const createApi = nativeHttp ? () => new DiscordApi({ token, fetchImpl: async (url, request) => {
    const target = new URL(url);
    const path = target.pathname.replace('/api/v10/', '');
    assert.equal(request.headers.authorization, `Bot ${token}`);
    if (path === 'users/@me') return Response.json(await api.getCurrentUser());
    if (path === 'applications/@me') return Response.json(await api.getCurrentApplication());
    if (path === 'gateway/bot') return Response.json(await api.getGatewayBot());
    if (path === 'users/@me/guilds') {
      assert.equal(target.searchParams.get('limit'), '2');
      return Response.json(await api.getCurrentGuilds({ after: target.searchParams.get('after') ?? undefined }));
    }
    if (path === `guilds/${guildId}/channels`) return Response.json(await api.getGuildChannels());
    if (path === `guilds/${guildId}/members/${bot}`) return Response.json(await api.getGuildMember());
    if (path === `guilds/${guildId}`) return Response.json(await api.getGuild());
    if (path === `channels/${channelId}`) return Response.json(await api.getChannel({ channelId }));
    assert.equal(path, `channels/${channelId}/messages`);
    const body = JSON.parse(request.body);
    assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
    assert.equal(body.message_reference, undefined);
    return Response.json(await api.createMessage({ channelId, content: body.content }));
  } }) : () => api;
  const controller = new DiscordController({ configStore: store, logger,
    credentials: { resolve: async ref => ({ value: secrets.get(ref) }),
      set: async (ref, value) => secrets.set(ref, value), unset: async ref => secrets.delete(ref) },
    createApi, inspectToken: async () => ({ platformId: bot, name: 'Test bot' }),
    createRuntime: async options => new DiscordRuntime({ ...options, harness: { ensureRunning: async () => {} }, state: {},
      createApi, connectTimeoutMs: 500, logger,
      createWebSocket: () => { const socket = new Socket(); queueMicrotask(() => socket.packet({ op: 10, d: { heartbeat_interval: 45000 } })); return socket; } }),
  });
  t.after(async () => { await controller.close(); await rm(directory, { recursive: true, force: true }); });
  await controller.bindCredentials({ token: 'test-only' });
  const botId = store.list()[0].botId;
  const service = createDeliveryService();
  service.registerAdapter(createDeliveryAdapter({ channel: 'discord', coreController: controller,
    workspaces: { has: id => id === botId, listBotIds: () => [botId], listDeliveryTargets: () => [] },
    stateFor: async () => ({ snapshot: () => ({ sessions: {} }) }) }));
  const identity = await service.describeBot(botId);
  return { service, controller, botId, api, guild, channel, member, sends,
    options: { expectedFingerprint: identity.account.fingerprint, beforeSend: () => true } };
}

test('public Discord discovery and first post use current send permissions without history or a saved target', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.listReachableConversations(f.botId, f.options), {
    version: 1, conversations: [{ id: channelId, kind: 'group', name: 'Test server #qa' }], hasMore: false,
  });
  assert.deepEqual(await f.service.postConversationChecked(f.botId, channelId, 'First post', f.options), {
    sent: true, receipt: { version: 1, messageId: sentId, conversationId: channelId },
  });
  assert.deepEqual((await f.service.listTargets(f.botId)).targets, []);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].replyToMessageId, undefined);
  assert.equal(f.sends[0].retry, false);
});

test('Discord public group operations use native guild pagination and permission endpoints before a source-free HTTP send', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.service.listReachableConversations(f.botId, f.options)).conversations[0].id, channelId);
  assert.equal((await f.service.postConversationChecked(f.botId, channelId, 'Native HTTP first post', f.options)).receipt.messageId, sentId);
  assert.equal(f.sends.length, 1);
});

test('closing the Provider during native permission lookup refuses an unstarted Discord post', async t => {
  const f = await fixture(t);
  let enter; let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const lookup = new Promise(resolve => { release = resolve; });
  f.api.getGuild = async () => { enter(); await lookup; return f.guild; };
  const posted = f.service.postConversationChecked(f.botId, channelId, 'Must not send', f.options);
  await entered;
  const closed = f.controller.close();
  release();
  await assert.rejects(posted, { code: 'provider-unavailable' });
  await closed;
  assert.equal(f.sends.length, 0);
});

test('Discord permission revocation, timeout, cancellation and a lost result never dispatch or replay an unauthorized post', async t => {
  const f = await fixture(t);
  await f.service.listReachableConversations(f.botId, f.options);
  f.channel.permission_overwrites = [{ id: bot, type: 1, deny: '2048', allow: '0' }];
  await assert.rejects(f.service.postConversationChecked(f.botId, channelId, 'Revoked', f.options), { code: 'send-permission-denied' });
  f.channel.permission_overwrites = [];
  f.member.communication_disabled_until = '2099-01-01T00:00:00Z';
  await assert.rejects(f.service.postConversationChecked(f.botId, channelId, 'Timed out', f.options), { code: 'send-permission-denied' });
  delete f.member.communication_disabled_until;
  let current = true;
  f.api.getGuild = async () => { current = false; return f.guild; };
  await assert.rejects(f.service.postConversationChecked(f.botId, channelId, 'Final fence', {
    ...f.options, beforeSend: () => current,
  }), { code: 'send-permission-denied' });
  assert.equal(f.sends.length, 0);
  f.api.createMessage = async input => { f.sends.push(input); throw new Error('Lost response'); };
  await assert.rejects(f.service.postConversationChecked(f.botId, channelId, 'Unknown', f.options), { code: 'send-result-unknown' });
  assert.equal(f.sends.length, 1);
  const cancelled = AbortSignal.abort();
  await assert.rejects(f.service.postConversationChecked(f.botId, channelId, 'Cancelled', { ...f.options, signal: cancelled }), { code: 'cancelled' });
  assert.equal(f.sends.length, 1);
});

test('Discord pagination stays within one bounded channel page and validates opaque cursors', async t => {
  const f = await fixture(t);
  const channels = Array.from({ length: 101 }, (_, index) => ({ ...f.channel, id: String(600000000000000000n + BigInt(index)), name: `qa-${index}` }));
  f.api.getGuildChannels = async () => channels;
  const first = await f.service.listReachableConversations(f.botId, f.options);
  assert.equal(first.conversations.length, 100);
  assert.equal(first.hasMore, true);
  const next = await f.service.listReachableConversations(f.botId, { ...f.options, cursor: first.cursor });
  assert.deepEqual(next.conversations, [{ id: '600000000000000100', kind: 'group', name: 'Test server #qa-100' }]);
  assert.equal(next.hasMore, false);
  await assert.rejects(f.service.listReachableConversations(f.botId, { ...f.options, cursor: 'invalid' }), { code: 'bad-request' });
});
