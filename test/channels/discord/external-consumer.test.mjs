import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';
import { DiscordRuntime } from '../../../src/channels/discord/discord-runtime.mjs';
import { DiscordController } from '../../../src/channels/discord/discord-controller.mjs';
import { DiscordConfigStore, deriveDiscordBotIdentity } from '../../../src/channels/discord/config-store.mjs';
import { TokenBotController } from '../../../src/channels/shared/token-bot-controller.mjs';
import { ExclusiveInboundConsumers } from '../../../src/channels/shared/exclusive-inbound-consumers.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedDiscordAccount, discordMessageContentAllowed, normalizeDiscordExternalText, discordChannelPermissions,
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
  let callback; let fileOptIn; let ordinaryOptIn; let starts = 0; const modes = [];
  const controller = new DiscordController({ configStore: store,
    credentials: { resolve: async ref => values.has(ref) ? { value: values.get(ref) } : undefined,
      set: async (ref, value) => values.set(ref, value), unset: async ref => values.delete(ref) },
    createApi: () => identityApi, inspectToken: async () => ({ platformId: ids.bot, name: 'QA Bot' }),
    createRuntime: async ({ config, externalConsumer, externalSourceFiles, externalOrdinaryText }) => {
      callback = externalConsumer; fileOptIn = externalSourceFiles; ordinaryOptIn = externalOrdinaryText; modes.push(config.consumerMode);
      return { status: { ready: true }, start: async () => { starts++; }, stop: async () => {},
        qualifyReplyChecked: async route => route, replyChecked: async () => ({ sent: true }),
        externalFileChecked: async (route, file, { signal }) => (async function* () {
          signal.throwIfAborted(); yield Buffer.from('first'); signal.throwIfAborted(); yield Buffer.from('second');
        })(),
        historyChecked: async (route, query, { signal }) => {
          signal.throwIfAborted(); return { route, query };
        } };
    }, logger: { warn() {}, error() {} } });
  try {
    await controller.initialize(); const description = await controller.describeDeliveryAccount(refs.botId);
    assert.equal(description.account.fingerprint, account.fingerprint);
    assert.equal(description.capabilities.includes('history-text-checked'), true);
    assert.equal(description.capabilities.includes('thread-history-text-checked'), true);
    assert.equal(description.capabilities.includes('ordinary-text-consumer'), true);
    const dispose = await controller.consumeInbound(refs.botId, { expectedFingerprint: account.fingerprint,
      onEvent: async () => ({ accepted: true }) });
    assert.equal(store.get(refs.botId).consumerMode, 'external-consumer');
    assert.equal(fileOptIn(), false);
    assert.equal(ordinaryOptIn(), false);
    await assert.rejects(controller.externalFileChecked(refs.botId, {}, {}, { expectedFingerprint: account.fingerprint }), { code: 'capability-unavailable' });
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
    const fileDispose = await controller.consumeInbound(refs.botId, { expectedFingerprint: account.fingerprint, sourceFiles: true, ordinaryText: true,
      onEvent: async () => ({ accepted: true }) });
    assert.equal(fileOptIn(), true);
    assert.equal(ordinaryOptIn(), true);
    const stream = await controller.externalFileChecked(refs.botId, route, {}, { expectedFingerprint: account.fingerprint });
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal(Buffer.from((await iterator.next()).value).toString(), 'first');
    fileDispose(); assert.equal(fileOptIn(), false);
    assert.equal(ordinaryOptIn(), false);
    await assert.rejects(iterator.next(), { code: 'consumer-unavailable' });
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


test('Gateway attachment admission requires opted-in mention; rejects unsupported source without standalone work', async () => {
  const f = fixture(true); let socket; let optIn = true; const received = []; const failures = [];
  f.message.attachments = [{ id: ids.sent, filename: 'source.txt', size: 3, url: 'https://cdn.discordapp.com/private-signed', content_type: 'text/plain' }];
  const runtime = new DiscordRuntime({ config: { botId: 'discord-qa', platformId: ids.bot, consumerMode: 'external-consumer' },
    token: 'test-private-token', harness: { ensureRunning: async () => true }, state: {}, externalSourceFiles: () => optIn,
    externalConsumer: async evidence => { received.push(evidence); return { accepted: true }; },
    createApi: () => ({ ...f.api, ...identityApi, getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }) }),
    createWebSocket: () => { socket = new Socket(); queueMicrotask(() => socket.packet({ op: 10, d: { heartbeat_interval: 45000 } })); return socket; },
    logger: { warn(...args) { failures.push(args); }, error(...args) { failures.push(args); } }, connectTimeoutMs: 200 });
  const dispatch = async message => { socket.packet({ op: 0, t: 'MESSAGE_CREATE', s: 42, d: message }); await flush(); };
  try {
    await runtime.start(); assert.equal(socket.sent[0].d.intents, (1 << 0) | (1 << 9));
    await dispatch(f.message); assert.equal(received.length, 1);
    assert.equal(received[0].attachments[0].resourceKey, ids.sent);
    assert.equal(received[0].reply.threadId, ids.thread);
    assert.equal(JSON.stringify(received[0]).includes('signed'), false);
    for (const value of [{ ...f.message, mentions: [] }, { ...f.message, author: { id: ids.actor, bot: true } },
      { ...f.message, webhook_id: ids.bot }, { ...f.message, attachments: [f.message.attachments[0], f.message.attachments[0]] }]) await dispatch(value);
    assert.equal(received.length, 1); assert.ok(failures.length > 0);
    optIn = false; await dispatch(f.message);
    assert.equal(received.length, 2); assert.equal(received[1].attachments, undefined);
    await assert.rejects(runtime.externalFileChecked(received[0].reply, received[0].attachments[0]), { code: 'capability-unavailable' });
  } finally { await runtime.stop(); }
});


test('shared Token controller refuses file opt-in when another provider lacks the file capability', async () => {
  const config = { botId: 'token-qa', tokenRef: 'token-ref' }; let starts = 0;
  const controller = new TokenBotController({ descriptor: { key: 'test', label: 'Test', connectionLabel: 'Test' },
    credentials: { resolve: async () => ({ value: 'token' }), set: async () => {}, unset: async () => {} },
    configStore: { get: () => config, list: () => [config], save: async value => value, remove: async () => {} },
    inspectToken: async () => ({}), deriveIdentity: () => ({}), maskPlatformId: value => value,
    createRuntime: async () => { starts++; }, checkedDelivery: { capabilities: ['exclusive-text-consumer'], inspectAccount: async () => account } });
  try {
    await assert.rejects(controller.consumeInbound('token-qa', { expectedFingerprint: account.fingerprint, sourceFiles: true,
      onEvent: async () => ({ accepted: true }) }), { code: 'capability-unavailable' });
    await assert.rejects(controller.externalFileChecked('token-qa', {}, {}, { expectedFingerprint: account.fingerprint }), { code: 'capability-unavailable' });
    await assert.rejects(controller.consumeInbound('token-qa', { expectedFingerprint: account.fingerprint, ordinaryText: true,
      onEvent: async () => ({ accepted: true }) }), { code: 'capability-unavailable' });
    assert.equal(starts, 0);
  } finally { await controller.close(); }
});

test('Message Content approval uses native exact flags and never infers permission from missing/malformed values', () => {
  for (const bit of [18, 19]) {
    assert.equal(discordMessageContentAllowed({ flags: 1 << bit }), true);
    assert.equal(discordMessageContentAllowed({ flags: 0, flags_new: String((1n << 60n) | (1n << BigInt(bit))) }), true);
  }
  for (const app of [{}, { flags: 0 }, { flags: 1 << 15 }, { flags: -1 }, { flags: '524288' },
    { flags: 1.1 }, { flags: 1 << 19, flags_new: 'bad' }, { flags_new: '-1' }, { flags_new: '0' }])
    assert.equal(discordMessageContentAllowed(app), false);
});

function ordinaryRuntimeFixture({ enabled = true, optedIn = true, thread = true } = {}) {
  const f = fixture(thread); let socket; let ordinary = optedIn; let applicationReads = 0;
  const received = []; const failures = [];
  let application = { id: ids.app, bot: { id: ids.bot, bot: true }, flags: enabled ? 1 << 19 : 0 };
  const api = { ...f.api, ...identityApi, getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
    getCurrentApplication: async () => { applicationReads++; return application; } };
  const runtime = new DiscordRuntime({ config: { botId: 'discord-qa', platformId: ids.bot, consumerMode: 'external-consumer' },
    token: 'test-private-token', harness: { ensureRunning: async () => true, createSession: async () => assert.fail('standalone') }, state: {},
    externalSourceFiles: () => true, externalOrdinaryText: () => ordinary,
    externalConsumer: async (evidence, signal) => { signal.throwIfAborted(); received.push(evidence); return { accepted: true }; },
    createApi: () => api,
    createWebSocket: () => { socket = new Socket(); queueMicrotask(() => socket.packet({ op: 10, d: { heartbeat_interval: 45000 } })); return socket; },
    logger: { warn(...args) { failures.push(args); }, error(...args) { failures.push(args); } }, connectTimeoutMs: 200 });
  return { ...f, api, runtime, received, failures,
    ordinaryMessage: { ...f.message, content: 'ordinary Human text', mentions: [] },
    get intents() { return socket.sent[0].d.intents; },
    get applicationReads() { return applicationReads; },
    setOptIn(value) { ordinary = value; },
    setApplication(value) { application = value; },
    async dispatch(message) { socket.packet({ op: 0, t: 'MESSAGE_CREATE', s: 42, d: message }); await flush(); } };
}

test('ordinary Gateway requires consumer opt-in AND native approval; OFF retains mention replies without privileged intent', async () => {
  for (const enabled of [false, true]) for (const optedIn of [false, true]) {
    const f = ordinaryRuntimeFixture({ enabled, optedIn });
    try {
      await f.runtime.start();
      assert.equal(f.intents, (1 << 0) | (1 << 9) | (enabled && optedIn ? 1 << 15 : 0));
      await f.dispatch(f.ordinaryMessage);
      assert.equal(f.received.length, enabled && optedIn ? 1 : 0);
      if (f.received.length) {
        assert.equal(f.received[0].mentionedAccount, false);
        assert.equal(f.received[0].reply.threadId, ids.thread);
        assert.equal(f.received[0].reply.conversationId, ids.channel);
        assert.equal(f.received[0].actor.id, ids.actor);
      }
      await f.dispatch(f.message);
      assert.equal(f.received.at(-1).mentionedAccount, true);
      const receipt = await f.runtime.replyChecked(f.received.at(-1).reply, 'checked reply', { beforeSend: () => true, receipt: true });
      assert.equal(receipt.receipt.messageId, ids.sent);
      assert.equal(f.sends.length, 1);
    } finally { await f.runtime.stop(); }
  }
});

test('ordinary channel text omits attachment resources and does not admit bot/webhook/empty/unsupported Human events', async () => {
  const f = ordinaryRuntimeFixture({ thread: false });
  try {
    await f.runtime.start();
    await f.dispatch({ ...f.ordinaryMessage, attachments: [{ id: ids.sent, filename: 'ordinary.txt', size: 3, url: 'private-url' }] });
    assert.equal(f.received.length, 1);
    assert.equal(f.received[0].attachments, undefined);
    assert.equal(f.received[0].reply.threadId, undefined);
    assert.equal(JSON.stringify(f.received[0]).includes('private-url'), false);
    for (const message of [{ ...f.ordinaryMessage, content: '' }, { ...f.ordinaryMessage, content: '  ' },
      { ...f.ordinaryMessage, mentions: null }, { ...f.ordinaryMessage, author: { id: ids.bot, bot: true } },
      { ...f.ordinaryMessage, author: { id: ids.bot } }, { ...f.ordinaryMessage, webhook_id: ids.actor },
      { ...f.ordinaryMessage, type: 7 }, { ...f.ordinaryMessage, guild_id: undefined },
      { ...f.ordinaryMessage, guild_id: ids.actor }, { ...f.ordinaryMessage, timestamp: 'invalid' }]) await f.dispatch(message);
    assert.equal(f.received.length, 1);
    f.parent.type = 12; await f.dispatch(f.ordinaryMessage); assert.equal(f.received.length, 1);
    f.parent.type = 0; f.guild.roles[0].permissions = '0';
    await f.dispatch(f.ordinaryMessage); assert.equal(f.received.length, 1);
  } finally { await f.runtime.stop(); }
});

test('native revocation/identity change and consumer opt-out stop ordinary intake with no fallback', async () => {
  const f = ordinaryRuntimeFixture();
  try {
    await f.runtime.start();
    f.setApplication({ id: ids.app, bot: { id: ids.bot }, flags: 0 });
    await f.dispatch(f.ordinaryMessage); assert.equal(f.received.length, 0);
    f.setApplication({ id: ids.actor, bot: { id: ids.bot }, flags: 1 << 19 });
    await f.dispatch(f.ordinaryMessage); assert.equal(f.received.length, 0);
    assert.ok(f.failures.some(row => row.some(value => String(value).includes('account-changed'))));
    f.setApplication({ id: ids.app, bot: { id: ids.bot }, flags: 1 << 19 });
    f.setOptIn(false); const reads = f.applicationReads;
    await f.dispatch(f.ordinaryMessage); assert.equal(f.received.length, 0); assert.equal(f.applicationReads, reads);
    f.setOptIn(true); const original = f.api.getChannel;
    f.api.getChannel = async args => { const channel = await original(args); f.setOptIn(false); return channel; };
    await f.dispatch(f.ordinaryMessage); assert.equal(f.received.length, 0);
  } finally { await f.runtime.stop(); }
});

test('ordinary native preflight cancelled by runtime disposal never reaches the exclusive consumer', async () => {
  const f = ordinaryRuntimeFixture(); let unblock; let started;
  const entered = new Promise(resolve => { started = resolve; });
  try {
    await f.runtime.start();
    f.api.getCurrentApplication = async () => { started(); return new Promise(resolve => { unblock = resolve; }); };
    await f.dispatch(f.ordinaryMessage); await entered;
    await f.runtime.stop(); unblock({ id: ids.app, bot: { id: ids.bot }, flags: 1 << 19 }); await flush();
    assert.equal(f.received.length, 0);
  } finally { await f.runtime.stop(); }
});

test('reply mentions ping only the source author or users the source mentions', async () => {
  const other = '123412341234123412';
  const f = fixture(); const route = (await event(f)).reply;
  f.message.mentions.push({ id: other });
  await sendDiscordReply(f.api, account, route, 'QA reply', { mentionUserIds: [ids.actor, other] });
  assert.deepEqual(f.sends[0].mentionUserIds, [ids.actor, other]);
  await assert.rejects(sendDiscordReply(f.api, account, route, 'QA', { mentionUserIds: ['999999999999999998'] }), { code: 'bad-request' });
  await assert.rejects(sendDiscordReply(f.api, account, route, 'QA', { mentionUserIds: ['everyone'] }), { code: 'bad-request' });
  await sendDiscordReply(f.api, account, route, 'QA plain');
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].mentionUserIds, undefined);
  let body;
  const api = new DiscordApi({ token: `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(30)}`,
    fetchImpl: async (_url, request) => { body = JSON.parse(request.body);
      return Response.json({ id: ids.sent, channel_id: ids.channel, author: { id: ids.bot, bot: true } }); } });
  await api.createMessage({ channelId: ids.channel, content: 'hi', mentionUserIds: [ids.actor], retry: false });
  assert.equal(body.content, `<@${ids.actor}> hi`);
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false, users: [ids.actor] });
});

test('Discord keeps checked mentions inline and prefixes only missing ones', async () => {
  let body;
  const api = new DiscordApi({ token: `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(30)}`,
    fetchImpl: async (_url, request) => { body = JSON.parse(request.body);
      return Response.json({ id: ids.sent, channel_id: ids.channel, author: { id: ids.bot, bot: true } }); } });
  await api.createMessage({ channelId: ids.channel, content: `ok <@${ids.actor}> done`, mentionUserIds: [ids.actor, ids.message], retry: false });
  assert.equal(body.content, `<@${ids.message}> ok <@${ids.actor}> done`);
  assert.deepEqual(body.allowed_mentions.users, [ids.actor, ids.message]);
});
