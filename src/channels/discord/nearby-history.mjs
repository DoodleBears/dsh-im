import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { discordRefusal } from './external-consumer.mjs';

const epoch = 1420070400000n;
const ttl = 30 * 60 * 1000;
const idAt = ms => String((BigInt(Math.max(Number(epoch), ms)) - epoch) << 22n);
const compare = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

/** Query state is runtime-local, signed and body-free; native text remains provider-owned. */
export function createDiscordNearbyReader({ now = Date.now } = {}) {
  const key = randomBytes(32);
  const sign = body => createHmac('sha256', key).update(body).digest('base64url');
  const encode = (binding, state) => {
    const body = Buffer.from(JSON.stringify({ binding, state: { ...state, expiresAt: now() + ttl } })).toString('base64url');
    const cursor = `${body}.${sign(body)}`;
    if (cursor.length > 4096) throw discordRefusal('history-unavailable');
    return cursor;
  };
  function prepare(binding, route, query) {
    if (query.cursor !== undefined) {
      try {
        if (typeof query.cursor !== 'string' || !query.cursor || query.cursor.length > 4096) throw new Error();
        const parts = query.cursor.split('.');
        if (parts.length !== 2) throw new Error();
        const expected = Buffer.from(sign(parts[0])); const actual = Buffer.from(parts[1]);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
        const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        if (value.binding !== binding || value.state.expiresAt <= now()) throw new Error();
        return value.state;
      } catch { throw discordRefusal('invalid-history-query'); }
    }
    const center = Number((BigInt(route.messageId) >> 22n) + epoch);
    const snapshot = idAt(now() + 1);
    if (compare(route.messageId, snapshot) >= 0) throw discordRefusal('stale-route');
    const low = idAt(center - 300000);
    const high = idAt(center + 300001); // Exclusive boundary includes every Snowflake in the end millisecond.
    const before = compare(snapshot, high) < 0 ? snapshot : high;
    return { phase: 'window', low, high, snapshot, before, center,
      beforeCount: 0, afterCount: 0, anchorSeen: false, candidates: [] };
  }

  async function read({ binding, state, query, route, source, page, message, normalize }) {
    const minBefore = query.beforeCount ?? 10;
    const minAfter = query.afterCount ?? 5;
    const events = []; let omitted = 0;
    const needsAfter = () => state.afterCount < minAfter && compare(state.high, state.snapshot) < 0;
    const endWindow = () => {
      state.phase = needsAfter() ? 'after' : 'done';
      if (state.phase === 'after') state.before = state.snapshot;
    };
    if (state.phase === 'window') {
      if (!state.anchorSeen) {
        const anchor = normalize(source);
        if (anchor) events.push(anchor); else omitted++;
        state.anchorSeen = true;
      }
      const room = query.limit - events.length - omitted;
      if (room > 0) {
        const rows = await page(state.before, room);
        let crossed = false;
        for (const row of rows) {
          if (row.id === route.messageId) continue;
          const event = normalize(row);
          if (compare(row.id, state.low) >= 0) {
            if (event) {
              if (compare(row.id, route.messageId) < 0) state.beforeCount = Math.min(20, state.beforeCount + 1);
              else state.afterCount = Math.min(20, state.afterCount + 1);
              events.push(event);
            } else omitted++;
          } else {
            crossed = true;
            if (event && state.beforeCount < minBefore) { state.beforeCount++; events.push(event); }
            else omitted++;
          }
        }
        if (rows.length) state.before = rows.at(-1).id;
        if (rows.length < room || (crossed && state.beforeCount >= minBefore)) endWindow();
      }
    } else if (state.phase === 'after') {
      // Discord lists newest first. Scan toward the upper window edge, retaining only
      // the closest required IDs; do not emit farther candidates before the scan settles.
      const rows = await page(state.before, query.limit);
      let crossed = false;
      for (const row of rows) {
        if (compare(row.id, state.high) < 0) { crossed = true; continue; }
        const event = normalize(row);
        if (!event) { omitted++; continue; }
        state.candidates.push(row.id);
        state.candidates.sort(compare);
        state.candidates = state.candidates.slice(0, minAfter - state.afterCount);
      }
      if (rows.length) state.before = rows.at(-1).id;
      if (rows.length < query.limit || crossed) {
        state.candidates.sort((a, b) => compare(b, a));
        state.phase = state.candidates.length ? 'emit' : 'done';
      }
    } else if (state.phase === 'emit') {
      for (const id of state.candidates.splice(0, query.limit)) {
        const row = await message(id);
        const event = row ? normalize(row) : null;
        if (event) events.push(event); else omitted++;
      }
      if (!state.candidates.length) state.phase = 'done';
    }
    const hasMore = state.phase !== 'done';
    return { version: 1, scope: 'nearby', events, omitted, hasMore,
      ...(hasMore ? { nextCursor: encode(binding, state) } : {}),
      window: { start: Math.floor((state.center - 300000) / 1000), end: Math.floor((state.center + 300000) / 1000) + 1 },
      coverage: 'provider-visible-human-text' };
  }
  return { prepare, read };
}
