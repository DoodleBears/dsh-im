import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackHistoryReader } from '../../../src/channels/slack/history-reader.mjs';
import { verifiedSlackAccount } from '../../../src/channels/slack/external-consumer.mjs';
import { SlackApi } from '../../../src/channels/slack/slack-api.mjs';

const account = verifiedSlackAccount({ team_id: 'T12345678', user_id: 'U12345678', bot_id: 'B12345678' },
  { id: 'B12345678', user_id: 'U12345678', app_id: 'A12345678', name: 'QA Bot' });
const identity = { account, botId: 'slack_0123456789abcdef01234567' };
const ts = (offset, micros = '000001') => `${1791128000 + offset}.${micros}`;
const message = (offset, extra = {}) => ({ type: 'message', ts: ts(offset), user: 'U87654321', text: `human ${offset}`, ...extra });
const route = { conversationId: 'C12345678', actorId: 'U87654321', messageId: ts(0), threadId: ts(0), rootId: ts(0) };
function fixture(messages, { thread = false } = {}) {
  const calls = [];
  const reader = createSlackHistoryReader({ now: () => (1791128000 + 10000) * 1000 });
  const api = {
    async historyPage(query) { return list(query, false); },
    async threadPage(query) { return list(query, true); },
    async getMessage(query) { calls.push({ exact: query }); return messages.find(m => m.ts === query.messageTs); },
    async userInfo({ userId }) { return { id: userId, real_name: 'QA Human' }; },
  };
  function list(query, ascending) {
    calls.push(query);
    let list = messages.filter(m => (!query.oldest || (query.inclusive ? m.ts >= query.oldest : m.ts > query.oldest))
      && (!query.latest || (query.inclusive ? m.ts <= query.latest : m.ts < query.latest)));
    if (ascending) list = list.filter(m => (m.thread_ts ?? m.ts) === query.threadTs);
    list.sort((a, b) => a.ts.localeCompare(b.ts) * (ascending ? 1 : -1));
    const offset = query.cursor ? Number(query.cursor) : 0;
    const items = list.slice(offset, offset + query.limit);
    const next = offset + items.length < list.length ? String(offset + items.length) : '';
    return { messages: items, has_more: Boolean(next), response_metadata: { next_cursor: next } };
  }
  const read = query => reader(api, identity, route, query, new AbortController().signal, () => {});
  return { read, reader, api, calls };
}
async function exhaust(fx, query) {
  const pages = [];
  do {
    const page = await fx.read(query); pages.push(page);
    assert.ok(page.events.length + page.omitted <= query.limit);
    query = { ...query, cursor: page.nextCursor };
    if (!page.hasMore) return pages;
    assert.ok(pages.length < 100);
  } while (true);
}

test('native group history is bounded newest-first, ordinary Human text is read without turning into a mention', async () => {
  const fx = fixture([message(-1), message(0), message(1), message(2, { bot_id: 'B99999999' })]);
  const pages = await exhaust(fx, { scope: 'group', limit: 2 });
  assert.deepEqual(pages.flatMap(p => p.events.map(e => e.messageId)), [ts(1), ts(0), ts(-1)]);
  assert.equal(pages[0].omitted, 1);
  const event = pages[0].events[0];
  assert.equal(event.mentionedAccount, false);
  assert.equal(event.actor.name, 'QA Human');
  assert.equal(event.eventId, `history:C12345678:${ts(1)}`);
  assert.equal(event.reply.parentId, undefined);
  assert.equal(event.reply.threadId, event.messageId);
  assert.equal(fx.calls[0].limit, 2);
});

test('native thread pages are earliest-first, preserve root IDs and exclude another thread', async () => {
  const fx = fixture([message(0), message(1, { thread_ts: ts(0) }), message(2, { thread_ts: ts(-100) }),
    message(3, { thread_ts: ts(0) })]);
  const pages = await exhaust(fx, { scope: 'thread', limit: 2 });
  assert.deepEqual(pages.flatMap(p => p.events.map(e => e.messageId)), [ts(0), ts(1), ts(3)]);
  assert.ok(pages.flatMap(p => p.events).every(e => e.reply.threadId === ts(0)));
});

test('dense nearby window traverses every page rather than truncating to the minima', async () => {
  const fx = fixture(Array.from({ length: 41 }, (_, i) => message(i - 20)));
  const pages = await exhaust(fx, { scope: 'nearby', limit: 3, beforeCount: 1, afterCount: 1 });
  assert.equal(pages.flatMap(p => p.events).length, 41);
  assert.equal(new Set(pages.flatMap(p => p.events.map(e => e.messageId))).size, 41);
  assert.equal(pages[0].window.start, 1791127700);
});

test('sparse nearby window supplements nearest messages on both sides across Slack reverse pages', async () => {
  const offsets = [-900, -800, -700, -600, -500, -400, -300, 0, 300, 400, 500, 600, 700, 800, 900];
  const fx = fixture(offsets.map(i => message(i)));
  const pages = await exhaust(fx, { scope: 'nearby', limit: 2, beforeCount: 3, afterCount: 3 });
  const actual = pages.flatMap(p => p.events.map(e => e.text)).sort();
  assert.deepEqual(actual, [-500, -400, -300, 0, 300, 400, 500].map(i => `human ${i}`).sort());
  assert.deepEqual(fx.calls.filter(c => c.exact).map(c => c.exact.messageTs), [ts(400), ts(500)]);
  // No text payload is cached inside continuations while scanning the after side.
  for (const p of pages.filter(p => p.nextCursor)) assert.ok(!Buffer.from(p.nextCursor.split('.')[0], 'base64url').toString().includes('human '));
});

test('microsecond boundaries are inclusive in the window and never duplicate across sparse supplementation', async () => {
  const fx = fixture([message(-301), message(-300, { ts: ts(-300, '000000') }), message(-300), message(0),
    message(300), message(300, { ts: ts(300, '000002') }), message(301)]);
  const pages = await exhaust(fx, { scope: 'nearby', limit: 2, beforeCount: 2, afterCount: 2 });
  const ids = pages.flatMap(p => p.events.map(e => e.messageId));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(ids), new Set([ts(-300, '000000'), ts(-300), ts(0), ts(300), ts(300, '000002')]));
});

test('signed cursors reject altered counts, account, source, scope, limit, tampering and replacement runtime', async () => {
  const fx = fixture([message(0), message(1), message(2)]);
  const page = await fx.read({ scope: 'group', limit: 1 });
  const query = { scope: 'group', limit: 1, cursor: page.nextCursor };
  for (const update of [{ limit: 2 }, { scope: 'thread' }, { cursor: page.nextCursor + 'x' }])
    await assert.rejects(fx.read({ ...query, ...update }), { code: 'invalid-history-query' });
  await assert.rejects(fx.reader(fx.api, { ...identity, botId: 'other' }, route, query, undefined, () => {}), { code: 'invalid-history-query' });
  await assert.rejects(fx.reader(fx.api, identity, { ...route, actorId: 'U11111111' }, query, undefined, () => {}), { code: 'invalid-history-query' });
  await assert.rejects(createSlackHistoryReader()(fx.api, identity, route, query, undefined, () => {}), { code: 'invalid-history-query' });
});

test('repeated cursors, oversized pages and cross-thread native results fail closed', async () => {
  const fx = fixture([message(0), message(1)]);
  fx.api.historyPage = async () => ({ messages: [message(1)], has_more: true, response_metadata: { next_cursor: 'same' } });
  const first = await fx.read({ scope: 'group', limit: 1 });
  await assert.rejects(fx.read({ scope: 'group', limit: 1, cursor: first.nextCursor }), { code: 'history-unavailable' });
  fx.api.historyPage = async () => ({ messages: [message(1), message(0)] });
  await assert.rejects(fx.read({ scope: 'group', limit: 1 }), { code: 'history-unavailable' });
  fx.api.threadPage = async () => ({ messages: [message(1, { thread_ts: ts(-1) })] });
  await assert.rejects(fx.read({ scope: 'thread', limit: 1 }), { code: 'stale-route' });
});

test('permission, cancellation and runtime replacement never leak an in-flight page', async () => {
  const fx = fixture([message(0)]);
  fx.api.historyPage = async () => { throw Object.assign(new Error('denied'), { providerCode: 'missing_scope' }); };
  await assert.rejects(fx.read({ scope: 'group', limit: 1 }), { code: 'history-permission-denied' });
  const abort = new AbortController();
  fx.api.historyPage = async () => { abort.abort(); return { messages: [message(0)] }; };
  await assert.rejects(fx.reader(fx.api, identity, route, { scope: 'group', limit: 1 }, abort.signal, () => {}), { name: 'AbortError' });
  let current = true;
  fx.api.historyPage = async () => { current = false; return { messages: [message(0)] }; };
  await assert.rejects(fx.reader(fx.api, identity, route, { scope: 'group', limit: 1 }, undefined,
    () => { if (!current) throw Object.assign(new Error(), { code: 'capability-unavailable' }); }), { code: 'capability-unavailable' });
});

test('form-encoded Slack history/replies preserve native cursors and bound each API page', async () => {
  const requests = [];
  const api = new SlackApi({ botToken: 'xoxb-test-1234567890123456', fetchImpl: async (url, request) => {
    const form = new URLSearchParams(request.body); requests.push({ method: new URL(url).pathname.split('/').at(-1), form });
    return Response.json({ ok: true, messages: [] });
  } });
  await api.historyPage({ channelId: route.conversationId, oldest: ts(-1), latest: ts(1), inclusive: true, cursor: 'native:cursor', limit: 3 });
  await api.threadPage({ channelId: route.conversationId, threadTs: ts(0), limit: 2 });
  assert.equal(requests[0].method, 'conversations.history');
  assert.equal(requests[0].form.get('cursor'), 'native:cursor');
  assert.equal(requests[0].form.get('limit'), '3');
  assert.equal(requests[0].form.get('inclusive'), 'true');
  assert.equal(requests[1].method, 'conversations.replies');
  assert.equal(requests[1].form.get('ts'), ts(0));
  await assert.rejects(async () => api.historyPage({ channelId: route.conversationId, limit: 21 }), /Invalid/);
});
