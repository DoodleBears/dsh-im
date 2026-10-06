import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';
import { DiscordRuntime } from '../../../src/channels/discord/discord-runtime.mjs';
import { DiscordController } from '../../../src/channels/discord/discord-controller.mjs';
import { DiscordConfigStore, deriveDiscordBotIdentity } from '../../../src/channels/discord/config-store.mjs';
import { ExclusiveInboundConsumers } from '../../../src/channels/shared/exclusive-inbound-consumers.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedDiscordAccount, normalizeDiscordExternalText, discordChannelPermissions,
  inspectDiscordSourceChannel, qualifyDiscordReply, sendDiscordReply } from '../../../src/channels/discord/external-consumer.mjs';

const ids = { bot: '111111111111111111', app: '222222222222222222', guild: '333333333333333333',
  channel: '444444444444444444', thread: '555555555555555555', actor: '666666666666666666',
  message: '777777777777777777', role: '888888888888888888', sent: '999999999999999999' };
const account = verifiedDiscordAccount({ id: ids.bot, bot: true, username: 'QA Bot' },
  { id: ids.app, bot: { id: ids.bot, bot: true } });
const identityApi = {
  getCurrentUser: async () => ({ id: ids.bot, bot: true, username: 'QA Bot' }),
  getCurrentApplication: async () => ({ id: ids.app, bot: { id: ids.bot, bot: true } }),
};
const permissions = (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 38n);
function fixture(thread = false) {
  const parent = { id: ids.channel, guild_id: ids.guild, type: 0, permission_overwrites: [] };
  const child = { id: ids.thread, parent_id: ids.channel, guild_id: ids.guild, type: 11,
    thread_metadata: { archived: false, locked: false } };
  const guild = { id: ids.guild, owner_id: ids.actor, roles: [{ id: ids.guild, permissions: String(permissions) }] };
  const member = { user: { id: ids.bot }, roles: [] };
  const message = { id: ids.message, channel_id: thread ? ids.thread : ids.channel, guild_id: ids.guild,
    author: { id: ids.actor, username: 'QA Human' }, type: 0, mentions: [{ id: ids.bot }],
    content: `<@${ids.bot}> QA`, timestamp: '2026-10-05T08:00:00Z' };
  const sends = [];
  const api = {
    getChannel: async ({ channelId }) => channelId === ids.thread ? child : parent,
    getGuild: async () => guild, getGuildMember: async () => member, getMessage: async () => message,
    createMessage: async input => { sends.push(input); return { id: ids.sent, channel_id: input.channelId,
      author: { id: ids.bot, bot: true } }; },
  };
  return { api, parent, child, guild, member, message, sends };
}
async function event(f) {
  const channel = await inspectDiscordSourceChannel(f.api, f.message.channel_id, account);
  return normalizeDiscordExternalText(f.message, { botId: 'discord-qa', account, channel, eventId: 'gateway-session:42' });
}

test('fingerprint verifies the App/user pair and is stable across presentation changes', () => {
  assert.equal(verifiedDiscordAccount({ id: ids.bot, bot: true, username: 'renamed' },
    { id: ids.app, bot: { id: ids.bot, bot: true } }).fingerprint, account.fingerprint);
  assert.throws(() => verifiedDiscordAccount({ id: ids.bot, bot: true },
    { id: ids.app, bot: { id: ids.actor, bot: true } }), { code: 'account-unverified' });
  assert.throws(() => verifiedDiscordAccount({ id: Number(ids.bot), bot: true },
    { id: ids.app, bot: { id: ids.bot, bot: true } }), { code: 'account-unverified' });
});

test('channel mention is native direct addressing, preserves IDs and creates no fake thread', async () => {
  const f = fixture(); const e = await event(f);
  assert.equal(e.messageId, ids.message); assert.equal(e.conversation.id, ids.channel);
  assert.equal(e.reply.threadId, undefined); assert.equal(e.reply.parentId, undefined);
  f.message.mentions = []; assert.equal(await event(f), null);
  f.message.mention_everyone = true; f.message.mention_roles = [ids.role]; assert.equal(await event(f), null);
  f.message.mentions = [{ id: ids.bot }]; f.message.author.bot = true; assert.equal(await event(f), null);
  f.message.author.bot = false; f.message.webhook_id = ids.actor; assert.equal(await event(f), null);
});

test('existing public thread retains native child and parent channel without fabricating message ancestry', async () => {
  const f = fixture(true); const e = await event(f);
  assert.equal(e.conversation.id, ids.channel); assert.equal(e.reply.threadId, ids.thread);
  assert.equal(e.reply.rootId, undefined); assert.equal(e.reply.parentId, undefined);
  f.child.guild_id = ids.actor;
  await assert.rejects(event(f), { code: 'stale-route' });
});

test('permission overwrite order and high thread bit use exact integers', () => {
  const f = fixture(); f.guild.roles.push({ id: ids.role, permissions: '0' }); f.member.roles.push(ids.role);
  f.parent.permission_overwrites.push({ type: 0, id: ids.guild, deny: String(1n << 38n), allow: '0' },
    { type: 0, id: ids.role, deny: '0', allow: String(1n << 38n) },
    { type: 1, id: ids.bot, deny: String(1n << 11n), allow: '0' });
  assert.equal(discordChannelPermissions(f.guild, f.member, f.parent, ids.bot), permissions & ~(1n << 11n));
  f.guild.roles[1].permissions = String(1n << 3n);
  assert.equal(discordChannelPermissions(f.guild, f.member, f.parent, ids.bot), ~0n);
});

test('same native location send checks source, permission and fence with a receipt and no fallback/retry', async () => {
  for (const thread of [false, true]) {
    const f = fixture(thread); const route = (await event(f)).reply;
    await assert.rejects(sendDiscordReply(f.api, account, route, 'refused', { beforeSend: () => false }), { code: 'stale-route' });
    assert.equal(f.sends.length, 0);
    const result = await sendDiscordReply(f.api, account, route, 'QA reply', { beforeSend: () => true, receipt: true });
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0].channelId, f.message.channel_id);
    assert.equal(f.sends[0].retry, false); assert.equal(f.sends[0].failIfNotExists, true);
    assert.deepEqual(result.receipt, { version: 1, messageId: ids.sent, conversationId: ids.channel });
    f.message.author.id = ids.bot;
    await assert.rejects(sendDiscordReply(f.api, account, route, 'refused'), { code: 'stale-route' });
    assert.equal(f.sends.length, 1);
  }
});

test('thread cannot borrow channel SEND_MESSAGES, and archived/locked threads refuse', async () => {
  const f = fixture(true); const route = (await event(f)).reply;
  f.guild.roles[0].permissions = String(permissions & ~(1n << 38n));
  await assert.rejects(qualifyDiscordReply(f.api, account, route), { code: 'reply-permission-denied' });
  f.guild.roles[0].permissions = String(permissions); f.child.thread_metadata.archived = true;
  await assert.rejects(qualifyDiscordReply(f.api, account, route), { code: 'reply-permission-denied' });
  f.child.thread_metadata.archived = false; f.child.thread_metadata.locked = true;
  await assert.rejects(qualifyDiscordReply(f.api, account, route), { code: 'reply-permission-denied' });
  f.child.thread_metadata.locked = false; f.child.type = 12;
  await assert.rejects(qualifyDiscordReply(f.api, account, route), { code: 'reply-permission-denied' });
});

test('transport/receipt ambiguity is unknown; mismatched routes never send', async () => {
  const f = fixture(); const route = (await event(f)).reply;
  await assert.rejects(qualifyDiscordReply(f.api, account, { ...route, threadId: ids.thread }), { code: 'stale-route' });
  f.api.createMessage = async () => { throw new Error('response lost after dispatch'); };
  await assert.rejects(sendDiscordReply(f.api, account, route, 'QA'), { code: 'reply-result-unknown' });
  f.api.createMessage = async () => ({ id: ids.sent, channel_id: ids.thread, author: { id: ids.bot, bot: true } });
  await assert.rejects(sendDiscordReply(f.api, account, route, 'QA'), { code: 'reply-result-unknown' });
  await assert.rejects(sendDiscordReply(f.api, account, route, 'x'.repeat(2001)), { code: 'bad-request' });
});

test('native API checked send disables automatic 429 retry and requires source to still exist', async () => {
  let calls = 0;
  const api = new DiscordApi({ token: `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(30)}`,
    fetchImpl: async (url, request) => {
      calls++; const body = JSON.parse(request.body);
      assert.equal(body.message_reference.fail_if_not_exists, true);
      assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
      return Response.json({ retry_after: 0.1, message: 'rate limited' }, { status: 429 });
    } });
  await assert.rejects(api.createMessage({ channelId: ids.channel, content: 'QA', replyToMessageId: ids.message,
    retry: false, failIfNotExists: true }), { status: 429 });
  assert.equal(calls, 1);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
class Socket {
  readyState = 1; listeners = new Map(); sent = [];
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  send(raw) {
    const packet = JSON.parse(raw); this.sent.push(packet);
    if (packet.op === 2) queueMicrotask(() => this.packet({ op: 0, t: 'READY', s: 1,
      d: { application: { id: ids.app }, user: { id: ids.bot, bot: true }, session_id: 'qa-gateway-session' } }));
  }
  packet(packet) { this.listeners.get('message')?.({ data: JSON.stringify(packet) }); }
  close() { this.readyState = 3; }
}
test('exclusive runtime uses mention intents and no standalone Session/thread, with redelivery and lost lease', async () => {
  const f = fixture(true); let socket; let sessions = 0; let creates = 0; let accepted = 0;
  const consumers = new ExclusiveInboundConsumers();
  const dispose = consumers.register('discord-qa', { fingerprint: account.fingerprint,
    onEvent: async evidence => { accepted++; assert.equal(evidence.reply.threadId, ids.thread); return { accepted: true }; } });
  const runtime = new DiscordRuntime({ config: { botId: 'discord-qa', platformId: ids.bot, consumerMode: 'external-consumer' },
    token: 'test-private-token', harness: { ensureRunning: async () => true, createSession: async () => { sessions++; } }, state: {},
    externalConsumer: (evidence, signal) => consumers.accept('discord-qa', evidence, signal),
    createApi: () => ({ ...f.api, ...identityApi, getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      startThreadFromMessage: async () => { creates++; throw new Error('must not create'); } }),
    createWebSocket: () => { socket = new Socket(); queueMicrotask(() => socket.packet({ op: 10, d: { heartbeat_interval: 45000 } })); return socket; },
    logger: { warn() {}, error() {} }, connectTimeoutMs: 200 });
  try {
    await runtime.start(); assert.equal(socket.sent[0].d.intents, (1 << 0) | (1 << 9));
    socket.packet({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: f.message }); await flush();
    assert.equal(accepted, 1); assert.equal(sessions, 0); assert.equal(creates, 0);
    socket.packet({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: f.message }); await flush();
    assert.equal(accepted, 2); // Messaging, not another Provider transcript, owns canonical deduplication.
    dispose(); socket.packet({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: f.message }); await flush();
    assert.equal(accepted, 2); assert.equal(sessions, 0); assert.equal(creates, 0);
    const route = (await event(f)).reply;
    const result = await runtime.replyChecked(route, 'QA reply', { beforeSend: () => true, receipt: true });
    assert.equal(result.receipt.messageId, ids.sent); assert.equal(f.sends[0].channelId, ids.thread);
  } finally { await runtime.stop(); consumers.close(); }
});

test('controller persists exclusive ownership, refuses conflicting/lost consumers, and preserves mode on token refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bh-discord-consumer-'));
  const path = join(directory, 'config.json'); const store = await new DiscordConfigStore(path).load();
  const refs = deriveDiscordBotIdentity(ids.bot); const values = new Map([[refs.tokenRef, 'test-token']]);
  await store.save({ ...refs, platformId: ids.bot, name: 'QA Bot' });
  let callback; let starts = 0; const modes = [];
  const controller = new DiscordController({ configStore: store,
    credentials: { resolve: async ref => values.has(ref) ? { value: values.get(ref) } : undefined,
      set: async (ref, value) => values.set(ref, value), unset: async ref => values.delete(ref) },
    createApi: () => identityApi, inspectToken: async () => ({ platformId: ids.bot, name: 'QA Bot' }),
    createRuntime: async ({ config, externalConsumer }) => {
      callback = externalConsumer; modes.push(config.consumerMode);
      return { status: { ready: true }, start: async () => { starts++; }, stop: async () => {},
        qualifyReplyChecked: async route => route, replyChecked: async () => ({ sent: true }),
        historyChecked: async (route, query, { signal }) => {
          signal.throwIfAborted(); return { route, query };
        } };
    }, logger: { warn() {}, error() {} } });
  try {
    await controller.initialize(); const description = await controller.describeDeliveryAccount(refs.botId);
    assert.equal(description.account.fingerprint, account.fingerprint);
    assert.equal(description.capabilities.includes('history-text-checked'), true);
    assert.equal(description.capabilities.includes('thread-history-text-checked'), true);
    const dispose = await controller.consumeInbound(refs.botId, { expectedFingerprint: account.fingerprint,
      onEvent: async () => ({ accepted: true }) });
    assert.equal(store.get(refs.botId).consumerMode, 'external-consumer');
    const route = { messageId: ids.message, actorId: ids.actor, conversationId: ids.channel };
    const query = { scope: 'group', limit: 2 };
    assert.deepEqual(await controller.historyChecked(refs.botId, route, query,
      { expectedFingerprint: account.fingerprint }), { route, query });
    await assert.rejects(controller.historyChecked(refs.botId, route, query,
      { expectedFingerprint: 'f'.repeat(64) }), { code: 'account-changed' });
    await assert.rejects(controller.consumeInbound(refs.botId, { expectedFingerprint: account.fingerprint,
      onEvent: async () => ({ accepted: true }) }), { code: 'consumer-conflict' });
    assert.equal(starts, 2); dispose();
    await assert.rejects(callback({ fingerprint: account.fingerprint }), { code: 'consumer-unavailable' });
    await assert.rejects(controller.replyChecked(refs.botId, {}, 'QA', { expectedFingerprint: account.fingerprint }), { code: 'consumer-unavailable' });
    await assert.rejects(controller.historyChecked(refs.botId, route, query,
      { expectedFingerprint: account.fingerprint }), { code: 'consumer-unavailable' });
    await controller.bindCredentials({ token: 'rotated-test-token' });
    assert.equal(modes.at(-1), 'external-consumer');
    assert.equal((await new DiscordConfigStore(path).load()).get(refs.botId).consumerMode, 'external-consumer');
  } finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
});

test('explicit external-only Profile connects a new identity without a standalone bootstrap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bh-discord-external-profile-'));
  const store = await new DiscordConfigStore(join(directory, 'config.json'), { consumerMode: 'external-consumer' }).load();
  const values = new Map(); const modes = [];
  const controller = new DiscordController({ configStore: store,
    credentials: { resolve: async ref => values.has(ref) ? { value: values.get(ref) } : undefined,
      set: async (ref, value) => values.set(ref, value), unset: async ref => values.delete(ref) },
    createApi: () => identityApi, inspectToken: async () => ({ platformId: ids.bot, name: 'QA Bot' }),
    createRuntime: async ({ config, externalConsumer }) => {
      modes.push(config.consumerMode); assert.equal(typeof externalConsumer, 'function');
      return { status: { ready: true }, start: async () => {}, stop: async () => {} };
    }, logger: { warn() {}, error() {} } });
  try {
    await controller.bindCredentials({ token: 'synthetic-private-token' });
    assert.deepEqual(modes, ['external-consumer']);
    assert.equal((await controller.describeDeliveryAccount(deriveDiscordBotIdentity(ids.bot).botId)).connected, true);
  } finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
});
