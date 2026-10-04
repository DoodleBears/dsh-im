import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeSlackHistoryText, slackRefusal, slackTimestamp } from './external-consumer.mjs';

const micros = value => BigInt(value.replace('.', ''));
const timestamp = value => `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`;
const compare = (a, b) => micros(a) < micros(b) ? -1 : micros(a) > micros(b) ? 1 : 0;
const coverage = 'provider-visible-human-text';

/** Runtime-local signed continuations contain native IDs/counts, never message bodies or credentials. */
export function createSlackHistoryReader({ now = Date.now } = {}) {
  const key = randomBytes(32);
  const sign = body => createHmac('sha256', key).update(body).digest('base64url');
  function encode(binding, state) {
    const body = Buffer.from(JSON.stringify({ binding, state })).toString('base64url');
    const cursor = `${body}.${sign(body)}`;
    if (cursor.length > 4096) throw slackRefusal('history-unavailable');
    return cursor;
  }
  function decode(cursor, binding) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 4096) throw new Error();
      const parts = cursor.split('.');
      if (parts.length !== 2) throw new Error();
      const actual = Buffer.from(parts[1]);
      const expected = Buffer.from(sign(parts[0]));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      if (parsed.binding !== binding) throw new Error();
      return parsed.state;
    } catch { throw slackRefusal('invalid-history-query'); }
  }

  return async function read(api, identity, route, query, signal, assertCurrent) {
    if (!query || (query.cursor !== undefined && (typeof query.cursor !== 'string' || !query.cursor))
      || !['group', 'thread', 'nearby'].includes(query.scope)
      || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 20
      || (query.scope !== 'nearby' && (query.beforeCount !== undefined || query.afterCount !== undefined)))
      throw slackRefusal('invalid-history-query');
    const minBefore = query.beforeCount ?? 10;
    const minAfter = query.afterCount ?? 5;
    if (![minBefore, minAfter].every(n => Number.isInteger(n) && n >= 0 && n <= 20))
      throw slackRefusal('invalid-history-query');
    const binding = createHash('sha256').update(JSON.stringify({ identity, route,
      scope: query.scope, limit: query.limit, minBefore, minAfter })).digest('hex');
    const state = query.cursor ? decode(query.cursor, binding) : {
      phase: query.scope === 'nearby' ? 'window' : 'page',
      snapshot: timestamp(BigInt(now()) * 1000n), before: 0, after: 0, candidates: [],
    };
    const check = () => { signal?.throwIfAborted(); assertCurrent(); };
    const checked = async call => { check(); const value = await call(); check(); return value; };
    const normalize = message => normalizeSlackHistoryText(message, { ...identity, conversationId: route.conversationId });
    const decorate = async events => {
      const names = new Map();
      return Promise.all(events.map(async event => {
        if (!names.has(event.actor.id)) names.set(event.actor.id, (async () => {
          try {
            const user = await checked(() => api.userInfo({ userId: event.actor.id, signal }));
            const name = user?.id === event.actor.id && (user.real_name || user.profile?.display_name || user.name);
            return typeof name === 'string' && name ? name.slice(0, 512) : undefined;
          } catch { check(); return undefined; }
        })());
        const name = await names.get(event.actor.id);
        return name ? { ...event, actor: { ...event.actor, name } } : event;
      }));
    };
    const output = async (events, omitted, more, window) => ({ version: 1, scope: query.scope,
      events: await decorate(events), omitted, hasMore: more,
      ...(more ? { nextCursor: encode(binding, state) } : {}), ...(window ? { window } : {}), coverage });
    const page = async (options, direction, bounds = {}) => {
      const raw = await checked(() => query.scope === 'thread'
        ? api.threadPage({ channelId: route.conversationId, threadTs: route.threadId, ...options, limit: Math.max(1, query.limit - 1), signal })
        : api.historyPage({ channelId: route.conversationId, ...options, limit: query.limit, signal }));
      if (!Array.isArray(raw?.messages)) throw slackRefusal('history-unavailable');
      let messages = raw.messages;
      const pinned = query.scope === 'thread' && messages[0]?.ts === route.threadId;
      // Slack may add the root outside the requested reply count, including on continuation pages.
      const nativeBound = query.scope === 'thread' ? Math.max(1, query.limit - 1) : query.limit;
      if (messages.length > nativeBound + (pinned ? 1 : 0)) throw slackRefusal('history-unavailable');
      if (pinned && state.rootSeen) messages = messages.slice(1);
      if (pinned) state.rootSeen = true;
      const cursor = raw.response_metadata?.next_cursor?.trim() || undefined;
      if ((cursor && (typeof cursor !== 'string' || cursor.length > 1800 || cursor === state.page))
        || (raw.has_more === true && !cursor) || (cursor && raw.messages.length === 0))
        throw slackRefusal('history-unavailable');
      let last = query.scope === 'thread' ? undefined : state.last;
      for (const message of messages) {
        if (!slackTimestamp(message?.ts) || (last && compare(message.ts, last) !== direction)
          || (bounds.lower && (compare(message.ts, bounds.lower) < 0
            || (!bounds.inclusive && message.ts === bounds.lower)))
          || (bounds.upper && (compare(message.ts, bounds.upper) > 0
            || (!bounds.inclusive && message.ts === bounds.upper))))
          throw slackRefusal('history-unavailable');
        last = message.ts;
        if (query.scope === 'thread' && (message.thread_ts ?? message.ts) !== route.threadId)
          throw slackRefusal('stale-route');
      }
      if (query.scope === 'thread') {
        const children = messages.filter(message => message.ts !== route.threadId);
        if (children.length) {
          const low = children[0].ts;
          const high = children.at(-1).ts;
          if (state.threadLow) {
            const direction = compare(high, state.threadLow) < 0 ? 'older'
              : compare(low, state.threadHigh) > 0 ? 'newer' : undefined;
            if (!direction || (state.threadDirection && direction !== state.threadDirection))
              throw slackRefusal('history-unavailable');
            state.threadDirection = direction;
            if (direction === 'older') state.threadLow = low;
            else state.threadHigh = high;
          } else { state.threadLow = low; state.threadHigh = high; }
        }
      }
      state.page = cursor;
      state.last = last;
      if (messages.length > query.limit) {
        // Only limit=1 can leave one extra root-page item. Re-read its exact native ID next call.
        state.pending = messages.at(-1).ts;
        messages = messages.slice(0, query.limit);
      }
      return { messages, more: Boolean(cursor) || Boolean(state.pending) };
    };
    try {
      check();
      if (query.scope !== 'nearby') {
        if (state.pending) {
          const pending = state.pending;
          const raw = await checked(() => api.threadMessage({ channelId: route.conversationId,
            threadTs: route.threadId, messageTs: pending, signal }));
          if (raw && (raw.ts !== pending || (raw.thread_ts ?? raw.ts) !== route.threadId))
            throw slackRefusal('stale-route');
          const event = raw ? normalize(raw) : null;
          delete state.pending;
          return await output(event ? [event] : [], event ? 0 : 1, Boolean(state.page));
        }
        const result = await page({ cursor: state.page, latest: state.snapshot }, query.scope === 'thread' ? 1 : -1,
          { upper: state.snapshot });
        const events = result.messages.map(normalize).filter(Boolean);
        return await output(events, result.messages.length - events.length, result.more);
      }
      const center = micros(route.messageId);
      const start = timestamp(center - 300_000_000n);
      const end = timestamp(center + 300_000_000n);
      const ceiling = compare(end, state.snapshot) < 0 ? end : state.snapshot;
      const window = { start: Number(micros(start) / 1_000_000n), end: Number(micros(end) / 1_000_000n) + 1 };
      const transition = phase => { state.phase = phase; delete state.page; delete state.last; };
      const needsAfter = () => state.after < minAfter && compare(end, state.snapshot) < 0;
      if (state.phase === 'emit') {
        const selected = state.candidates.splice(0, query.limit);
        const events = [];
        for (const ts of selected) {
          const raw = await checked(() => api.getMessage({ channelId: route.conversationId, messageTs: ts, signal }));
          const event = raw?.ts === ts ? normalize(raw) : null;
          if (event) events.push(event);
        }
        return await output(events, selected.length - events.length, state.candidates.length > 0, window);
      }
      const options = state.phase === 'window'
        ? { oldest: start, latest: ceiling, inclusive: true }
        : state.phase === 'before' ? { latest: start, inclusive: false }
          : { oldest: end, latest: state.snapshot, inclusive: false };
      const result = await page({ ...options, cursor: state.page }, -1, {
        lower: options.oldest, upper: options.latest, inclusive: options.inclusive,
      });
      const normalized = result.messages.map(normalize);
      const events = [];
      let omitted = normalized.filter(event => !event).length;
      for (const event of normalized.filter(Boolean)) {
        if (state.phase === 'window') {
          if (compare(event.messageId, route.messageId) < 0) state.before = Math.min(20, state.before + 1);
          if (compare(event.messageId, route.messageId) > 0) state.after = Math.min(20, state.after + 1);
          events.push(event);
        } else if (state.phase === 'before') {
          if (state.before < minBefore) { state.before++; events.push(event); } else omitted++;
        } else {
          // History is newest-first: retain only closest IDs while scanning towards the window.
          state.candidates.push(event.messageId);
          state.candidates.sort(compare);
          state.candidates = state.candidates.slice(0, minAfter - state.after);
        }
      }
      let more = result.more;
      if (state.phase === 'window' && !result.more) {
        if (state.before < minBefore) { transition('before'); more = true; }
        else if (needsAfter()) { transition('after'); more = true; }
      } else if (state.phase === 'before' && (state.before >= minBefore || !result.more)) {
        more = needsAfter();
        if (more) transition('after');
      } else if (state.phase === 'after' && !result.more) {
        more = state.candidates.length > 0;
        if (more) transition('emit');
      }
      return await output(events, omitted, more, window);
    } catch (error) {
      check();
      if (error?.code === 'invalid-history-query' || error?.code === 'stale-route'
        || error?.code === 'history-unavailable') throw error;
      if (['missing_scope', 'not_in_channel', 'channel_not_found', 'is_archived', 'no_permission'].includes(error?.providerCode))
        throw slackRefusal('history-permission-denied');
      if (error?.providerCode === 'thread_not_found') throw slackRefusal('thread-unavailable');
      throw slackRefusal('history-unavailable');
    }
  };
}
