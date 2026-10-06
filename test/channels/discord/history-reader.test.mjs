import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordHistoryReader } from '../../../src/channels/discord/history-reader.mjs';
import { normalizeDiscordExternalText, verifiedDiscordAccount } from '../../../src/channels/discord/external-consumer.mjs';
import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';

const ids = { bot: '111111111111111111', app: '222222222222222222', guild: '333333333333333333',
  channel: '444444444444444444', thread: '555555555555555555', actor: '666666666666666666',
  source: '777777777777777777' };
const permissions = (1n << 10n) | (1n << 16n); // Read access works without send permission.
function fixture(thread = false) {
  const user = { id: ids.bot, bot: true, username: 'QA' };
  const app = { id: ids.app, bot: user, flags: 1 << 19 };
  const parent = { id: ids.channel, guild_id: ids.guild, type: 0, permission_overwrites: [] };
  const child = { id: ids.thread, guild_id: ids.guild, parent_id: ids.channel, type: 11,
    thread_metadata: { archived: false, locked: false } };
  const guild = { id: ids.guild, owner_id: ids.actor,
    roles: [{ id: ids.guild, permissions: String(permissions) }] };
  const member = { user, roles: [] };
  const message = (id, channelId = thread ? ids.thread : ids.channel) => ({ id, channel_id: channelId,
    type: 0, author: { id: ids.actor, username: 'Human' }, mentions: [], content: `ordinary-${id}`,
    timestamp: '2026-10-05T08:00:00Z' });
  const source = message(ids.source);
  const pages = [[message(ids.source), message('700000000000000000')], [message('600000000000000000')]];
  const calls = [];
  const api = { getCurrentUser: async () => user, getCurrentApplication: async () => app,
    getChannel: async ({ channelId }) => channelId === ids.thread ? child : parent,
    getGuild: async () => guild, getGuildMember: async () => member, getMessage: async () => source,
    getMessages: async input => { calls.push(input); return pages.shift() ?? []; } };
  const identity = { botId: 'discord-qa', account: verifiedDiscordAccount(user, app) };
  const route = { messageId: ids.source, actorId: ids.actor, conversationId: ids.channel,
    ...(thread ? { threadId: ids.thread } : {}) };
  return { api, identity, route, pages, calls, app, parent, child, guild, source, message };
}
const query = { scope: 'group', limit: 2 };
const read = (reader, f, q = query, signal, current) => reader(f.api, f.identity, f.route, q, signal, current);

test('ordinary Human text is readable in bounded pages without becoming live intake', async () => {
  const f = fixture(); const reader = createDiscordHistoryReader();
  const first = await read(reader, f);
  assert.equal(first.events.length, 2); assert.equal(first.hasMore, true);
  assert.equal(first.events[0].mentionedAccount, false); assert.equal(first.omitted, 0);
  assert.equal(first.coverage, 'provider-visible-human-text');
  const channel = { guildId: ids.guild, conversationId: ids.channel, channelId: ids.channel };
  assert.equal(normalizeDiscordExternalText({ ...f.source, guild_id: ids.guild },
    { ...f.identity, channel, eventId: 'native:1' }), null);
  const second = await read(reader, f, { ...query, cursor: first.nextCursor });
  assert.equal(second.events.length, 1); assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, undefined); assert.equal(f.calls[1].before, '700000000000000000');
  assert.equal(f.calls[0].limit, 2);
});

test('thread history preserves child and parent; channel scope stays on the parent', async () => {
  const f = fixture(true); const reader = createDiscordHistoryReader();
  const page = await read(reader, f, { ...query, scope: 'thread' });
  assert.equal(f.calls[0].channelId, ids.thread);
  assert.equal(page.events[0].reply.threadId, ids.thread);
  assert.equal(page.events[0].conversation.id, ids.channel);
  f.pages.unshift([f.message('500000000000000000', ids.channel)]);
  const parent = await read(reader, f);
  assert.equal(f.calls[1].channelId, ids.channel); assert.equal(parent.events[0].reply.threadId, undefined);
});

test('App Message Content must be enabled, including empty or mention-only pages', async () => {
  for (const flags of [0, undefined, 1 << 8]) {
    const f = fixture(); f.app.flags = flags; f.pages.length = 0;
    await assert.rejects(read(createDiscordHistoryReader(), f), { code: 'history-permission-denied' });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.app.flags = 1 << 18;
  assert.equal((await read(createDiscordHistoryReader(), f)).events.length, 2);
});

test('native read denial refuses before Discord can misleadingly return HTTP 200 empty', async () => {
  const f = fixture(); f.guild.roles[0].permissions = String(1n << 10n);
  await assert.rejects(read(createDiscordHistoryReader(), f), { code: 'history-permission-denied' });
  assert.equal(f.calls.length, 0);
});

test('post-page permission and Message Content revocation discard the result', async () => {
  for (const revoke of [f => { f.app.flags = 0; }, f => { f.guild.roles[0].permissions = '0'; }]) {
    const f = fixture(); const original = f.api.getMessages;
    f.api.getMessages = async input => { const page = await original(input); revoke(f); return page; };
    await assert.rejects(read(createDiscordHistoryReader(), f), { code: 'history-permission-denied' });
  }
});

test('changed native account, source actor, thread parent and foreign channel refuse', async () => {
  for (const [change, code] of [
    [f => { f.api.getCurrentUser = async () => ({ id: ids.actor, bot: true }); }, 'account-unverified'],
    [f => { f.app.id = ids.actor; }, 'account-changed'],
    [f => { f.source.author.id = ids.bot; }, 'stale-route'],
    [f => { f.child.parent_id = ids.actor; }, 'stale-route'],
    [f => { f.pages[0][0].channel_id = ids.actor; }, 'stale-route'],
  ]) {
    const f = fixture(true); change(f);
    await assert.rejects(read(createDiscordHistoryReader(), f, { ...query, scope: 'thread' }), { code });
  }
});

test('cursor cannot move across runtimes, routes, accounts, limits, scopes or be tampered with', async () => {
  const f = fixture(true); const reader = createDiscordHistoryReader();
  const page = await read(reader, f, { ...query, scope: 'thread' });
  for (const [otherReader, other, q] of [
    [createDiscordHistoryReader(), f, { ...query, scope: 'thread' }],
    [reader, { ...f, route: { ...f.route, actorId: ids.bot } }, { ...query, scope: 'thread' }],
    [reader, { ...f, identity: { ...f.identity, botId: 'other' } }, { ...query, scope: 'thread' }],
    [reader, f, { ...query, scope: 'thread', limit: 1 }],
    [reader, f, query],
  ]) await assert.rejects(read(otherReader, other, { ...q, cursor: page.nextCursor }), { code: 'invalid-history-query' });
  await assert.rejects(read(reader, f, { ...query, scope: 'thread', cursor: `${page.nextCursor}x` }), { code: 'invalid-history-query' });
  assert.equal(f.calls.length, 1);
});

test('bounds and native order refuse oversized pages, duplicates, future IDs and foreign guilds', async () => {
  for (const mutate of [
    f => f.pages[0].push(f.message('600000000000000000')),
    f => { f.pages[0][1].id = ids.source; },
    f => { f.pages[0][0].id = '18446744073709551615'; },
    f => { f.pages[0][0].guild_id = ids.actor; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(read(createDiscordHistoryReader(), f), e => ['history-unavailable', 'stale-route'].includes(e.code));
  }
});

test('bot, webhook, system and empty-text rows are counted as omitted within the page bound', async () => {
  for (const mutate of [m => { m.author.bot = true; }, m => { m.webhook_id = ids.bot; },
    m => { m.type = 7; }, m => { m.content = ''; }]) {
    const f = fixture(); mutate(f.pages[0][1]);
    const page = await read(createDiscordHistoryReader(), f);
    assert.equal(page.events.length, 1); assert.equal(page.omitted, 1); assert.equal(page.hasMore, true);
  }
});

test('cancellation or runtime stop during the request cannot return content', async () => {
  for (const stop of [false, true]) {
    const f = fixture(); const controller = new AbortController(); let current = true;
    f.api.getMessages = async () => { if (stop) current = false; else controller.abort(); return []; };
    await assert.rejects(read(createDiscordHistoryReader(), f, query, controller.signal,
      () => { if (!current) throw Object.assign(new Error(), { code: 'capability-unavailable' }); }),
    { code: stop ? 'capability-unavailable' : 'cancelled' });
  }
});

test('invalid bounds and missing thread do not issue native requests', async () => {
  const f = fixture(); const reader = createDiscordHistoryReader();
  for (const q of [{ ...query, scope: 'unknown' }, { ...query, limit: 21 },
    { ...query, beforeCount: 0 }, { ...query, cursor: '' }])
    await assert.rejects(read(reader, f, q), { code: 'invalid-history-query' });
  await assert.rejects(read(reader, f, { ...query, scope: 'thread' }), { code: 'thread-unavailable' });
  assert.equal(f.calls.length, 0);
});

test('native HTTP paging passes only a bounded before query and caller cancellation', async () => {
  const calls = []; const controller = new AbortController();
  const api = new DiscordApi({ token: `${'a'.repeat(24)}.bbbb.${'c'.repeat(24)}`,
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => [] }; } });
  await api.getMessages({ channelId: ids.channel, before: ids.source, limit: 20, signal: controller.signal });
  const url = new URL(calls[0].url); assert.equal(url.pathname, `/api/v10/channels/${ids.channel}/messages`);
  assert.deepEqual([...url.searchParams], [['limit', '20'], ['before', ids.source]]);
  controller.abort(); assert.equal(calls[0].options.signal.aborted, true);
  assert.throws(() => api.getMessages({ channelId: ids.channel, limit: 101 }), TypeError);
});
