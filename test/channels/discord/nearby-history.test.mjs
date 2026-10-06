import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordHistoryReader } from '../../../src/channels/discord/history-reader.mjs';
import { verifiedDiscordAccount } from '../../../src/channels/discord/external-consumer.mjs';

const center = Date.parse('2026-10-06T07:00:00.123Z');
const epoch = 1420070400000n;
const snowflake = (offset, sequence = 1) => String((BigInt(center + offset) - epoch) << 22n | BigInt(sequence));
const ids = { bot: '111111111111111111', app: '222222222222222222', guild: '333333333333333333',
  channel: '444444444444444444', thread: '555555555555555555', actor: '666666666666666666' };
function fixture(records, { thread = false, time = center + 900000 } = {}) {
  let clock = time;
  const user = { id: ids.bot, bot: true, username: 'QA' };
  const app = { id: ids.app, bot: user, flags: 1 << 19 };
  const parent = { id: ids.channel, guild_id: ids.guild, type: 0, permission_overwrites: [] };
  const child = { id: ids.thread, guild_id: ids.guild, parent_id: ids.channel, type: 11,
    thread_metadata: { archived: false, locked: false } };
  const guild = { id: ids.guild, owner_id: ids.actor, roles: [{ id: ids.guild, permissions: String((1n << 10n) | (1n << 16n)) }] };
  const message = (offset, extra = {}) => ({ id: snowflake(offset), channel_id: thread ? ids.thread : ids.channel,
    guild_id: ids.guild, type: 0, author: { id: ids.actor }, mentions: [], content: `text-${offset}`,
    timestamp: new Date(center + offset).toISOString(), ...extra });
  const source = message(0); const rows = [source, ...records.map(r => Array.isArray(r) ? message(...r) : message(r))];
  const calls = [];
  const api = { getCurrentUser: async () => user, getCurrentApplication: async () => app,
    getChannel: async ({ channelId }) => channelId === ids.thread ? child : parent,
    getGuild: async () => guild, getGuildMember: async () => ({ user, roles: [] }),
    getMessage: async ({ messageId }) => rows.find(r => r.id === messageId),
    getMessages: async input => { calls.push(input); return rows.filter(r => BigInt(r.id) < BigInt(input.before))
      .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, input.limit); } };
  const identity = { botId: 'discord-qa', account: verifiedDiscordAccount(user, app) };
  const route = { messageId: source.id, actorId: ids.actor, conversationId: ids.channel, ...(thread ? { threadId: ids.thread } : {}) };
  const reader = createDiscordHistoryReader({ now: () => clock });
  const read = (query, signal, current, readWith = reader) => readWith(api, identity, route,
    { scope: 'nearby', limit: 3, ...query }, signal, current);
  return { read, reader, api, identity, route, rows, source, calls, app, guild, child,
    setTime: value => { clock = value; } };
}
async function all(f, query = {}) {
  const pages = []; let cursor;
  for (let n = 0; n < 100; ++n) {
    const p = await f.read({ ...query, ...(cursor ? { cursor } : {}) });
    pages.push(p);
    assert.ok(p.events.length <= (query.limit ?? 3));
    if (!p.nextCursor) { assert.equal(p.hasMore, false); return pages; }
    assert.equal(p.hasMore, true); assert.notEqual(p.nextCursor, cursor); cursor = p.nextCursor;
  }
  assert.fail('Nearby did not exhaust within the fixture history');
}
const offsets = pages => pages.flatMap(p => p.events.map(e => Date.parse(e.at) - center));
const sorted = values => [...values].sort((a, b) => a - b);

test('dense window traverses every native page independently of minima and includes the anchor once', async () => {
  const records = Array.from({ length: 35 }, (_, i) => (i + 1) * 5000);
  const f = fixture([...records, -1, -299999, -300000, 300000, 300001]);
  const pages = await all(f, { beforeCount: 0, afterCount: 0 });
  assert.deepEqual(sorted(offsets(pages)), sorted([0, ...records, -1, -299999, -300000, 300000]));
  assert.equal(new Set(pages.flatMap(p => p.events.map(e => e.messageId))).size, offsets(pages).length);
  assert.ok(f.calls.every(c => c.limit <= 3 && c.channelId === ids.channel));
  assert.deepEqual(pages[0].window, { start: Math.floor((center - 300000) / 1000), end: Math.floor((center + 300000) / 1000) + 1 });
});

test('sparse sides supplement nearest supported Human text, skipping bots/webhooks/empty/system records', async () => {
  const f = fixture([-1000, 1000, -300001, -400000, -500000, -600000,
    [-300002, { author: { id: ids.bot, bot: true } }], [-300003, { webhook_id: ids.bot }],
    [-300004, { content: '' }], [-300005, { type: 7 }],
    300001, 400000, 500000, 600000, 700000, 800000]);
  const pages = await all(f, { beforeCount: 3, afterCount: 3, limit: 2 });
  assert.deepEqual(sorted(offsets(pages)), [-400000, -300001, -1000, 0, 1000, 300001, 400000]);
  assert.ok(pages.reduce((sum, p) => sum + p.omitted, 0) >= 4);
});

test('defaults supplement ten preceding and five following texts; exhausted sparse history returns fewer', async () => {
  const records = [...Array.from({ length: 14 }, (_, i) => -400000 - i * 1000),
    ...Array.from({ length: 9 }, (_, i) => 400000 + i * 1000)];
  const pages = await all(fixture(records));
  assert.deepEqual(sorted(offsets(pages)), sorted([0, ...records.filter(n => n < 0).slice(0, 10), ...records.filter(n => n > 0).slice(0, 5)]));
  assert.deepEqual(sorted(offsets(await all(fixture([-400000, 400000])))), [-400000, 0, 400000]);
});

test('snapshot excludes messages arriving during continuation and does not await a future window', async () => {
  const f = fixture([-1000, -400000, 1000, 400000], { time: center + 2000 });
  const first = await f.read({ limit: 1 });
  f.setTime(center + 1000000);
  const pages = [first]; let cursor = first.nextCursor;
  while (cursor) { const p = await f.read({ limit: 1, cursor }); pages.push(p); cursor = p.nextCursor; }
  assert.deepEqual(sorted(offsets(pages)), [-400000, -1000, 0, 1000]);
  assert.ok(f.calls.every(c => BigInt(c.before) <= BigInt(snowflake(2001, 0))));
});

test('nearby in an existing public thread stays in that exact child container', async () => {
  const f = fixture([-400000, -1000, 1000, 400000], { thread: true });
  const pages = await all(f);
  assert.ok(f.calls.every(c => c.channelId === ids.thread));
  assert.ok(pages.flatMap(p => p.events).every(e => e.conversation.id === ids.channel && e.reply.threadId === ids.thread));
  f.child.parent_id = ids.actor;
  await assert.rejects(f.read(), { code: 'stale-route' });
});

test('signed nearby cursor binds counts, identity, route and limit; restart/tampering/expiry refuse before native paging', async () => {
  const f = fixture([-1000, 1000]); const first = await f.read({ limit: 1 });
  const calls = f.calls.length;
  for (const q of [{ beforeCount: 1 }, { afterCount: 1 }, { limit: 2 }, { cursor: `${first.nextCursor}x` }])
    await assert.rejects(f.read({ limit: 1, cursor: first.nextCursor, ...q }), { code: 'invalid-history-query' });
  await assert.rejects(f.read({ limit: 1, cursor: first.nextCursor }, undefined, undefined,
    createDiscordHistoryReader()), { code: 'invalid-history-query' });
  f.route.actorId = ids.bot;
  await assert.rejects(f.read({ limit: 1, cursor: first.nextCursor }), { code: 'invalid-history-query' });
  f.route.actorId = ids.actor;
  f.identity.botId = 'other';
  await assert.rejects(f.read({ limit: 1, cursor: first.nextCursor }), { code: 'invalid-history-query' });
  f.identity.botId = 'discord-qa';
  f.setTime(center + 900000 + 30 * 60000);
  await assert.rejects(f.read({ limit: 1, cursor: first.nextCursor }), { code: 'invalid-history-query' });
  assert.equal(f.calls.length, calls);
});

test('a successful continuation renews its 30-minute lifetime without changing its snapshot', async () => {
  const f = fixture([-1000, 1000]); const first = await f.read({ limit: 1 });
  f.setTime(center + 900000 + 29 * 60000);
  const second = await f.read({ limit: 1, cursor: first.nextCursor });
  f.setTime(center + 900000 + 58 * 60000);
  assert.ok((await f.read({ limit: 1, cursor: second.nextCursor })).events.length <= 1);
});

test('nearby retains preflight and post-page permission and runtime cancellation fences', async () => {
  for (const stop of ['content', 'permission', 'cancel', 'runtime']) {
    const f = fixture([-1000]); const abort = new AbortController(); let active = true;
    const get = f.api.getMessages;
    f.api.getMessages = async input => { const rows = await get(input);
      if (stop === 'content') f.app.flags = 0;
      else if (stop === 'permission') f.guild.roles[0].permissions = '0';
      else if (stop === 'cancel') abort.abort(); else active = false;
      return rows; };
    await assert.rejects(f.read({}, abort.signal, () => {
      if (!active) throw Object.assign(new Error(), { code: 'capability-unavailable' });
    }), { code: stop === 'cancel' ? 'cancelled' : stop === 'runtime' ? 'capability-unavailable' : 'history-permission-denied' });
  }
  const f = fixture([]); f.app.flags = 0;
  await assert.rejects(f.read(), { code: 'history-permission-denied' }); assert.equal(f.calls.length, 0);
  for (const value of [-1, 21, 1.5, '10']) await assert.rejects(f.read({ beforeCount: value }), { code: 'invalid-history-query' });
});

test('an unsupported anchor remains an omission within the result budget, without fabricated text', async () => {
  const f = fixture([-1000, 1000]); f.source.content = '';
  const pages = await all(f, { limit: 1, beforeCount: 0, afterCount: 0 });
  assert.deepEqual(sorted(offsets(pages)), [-1000, 1000]);
  assert.equal(pages.reduce((sum, p) => sum + p.omitted, 0), 1);
  assert.ok(pages.every(p => p.events.length + p.omitted <= 1));
});

test('same-millisecond Snowflakes at the window edges are included exactly once', async () => {
  const f = fixture([[-300000, { id: snowflake(-300000, 0) }],
    [300000, { id: snowflake(300000, 4194303) }], -300001, 300001]);
  const pages = await all(f, { limit: 2, beforeCount: 0, afterCount: 0 });
  assert.deepEqual(sorted(offsets(pages)), [-300000, 0, 300000]);
});
