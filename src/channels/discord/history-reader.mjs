import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { discordRefusal, inspectDiscordSourceChannel, normalizeDiscordHistoryText,
  verifiedDiscordAccount } from './external-consumer.mjs';
import { createDiscordNearbyReader } from './nearby-history.mjs';

const epoch = 1420070400000n;
const coverage = 'provider-visible-human-text';
const contentFlags = (1 << 18) | (1 << 19);
const snowflake = value => typeof value === 'string' && /^[1-9][0-9]{4,19}$/.test(value)
  && BigInt(value) <= (1n << 64n) - 1n;

/** Bounded native pages; runtime-local cursors contain IDs, never text or credentials. */
export function createDiscordHistoryReader({ now = Date.now } = {}) {
  const nearby = createDiscordNearbyReader({ now });
  const key = randomBytes(32);
  const sign = body => createHmac('sha256', key).update(body).digest('base64url');
  const encode = (binding, before) => {
    const body = Buffer.from(JSON.stringify({ binding, before })).toString('base64url');
    return `${body}.${sign(body)}`;
  };
  const decode = (cursor, binding) => {
    try {
      if (typeof cursor !== 'string' || !cursor || cursor.length > 4096) throw new Error();
      const parts = cursor.split('.');
      if (parts.length !== 2) throw new Error();
      const expected = Buffer.from(sign(parts[0]));
      const actual = Buffer.from(parts[1]);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
      const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      if (value.binding !== binding || !snowflake(value.before)) throw new Error();
      return value.before;
    } catch { throw discordRefusal('invalid-history-query'); }
  };

  return async function read(api, identity, route, query, signal, assertCurrent = () => {}) {
    const check = () => {
      if (signal?.aborted) throw discordRefusal('cancelled');
      assertCurrent();
    };
    const checked = async operation => { check(); const result = await operation(); check(); return result; };
    try {
      check();
      if (!query || !['group', 'thread', 'nearby'].includes(query.scope)
        || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 20
        || (query.scope !== 'nearby' && (query.beforeCount !== undefined || query.afterCount !== undefined))
        || ![query.beforeCount ?? 10, query.afterCount ?? 5].every(n => Number.isInteger(n) && n >= 0 && n <= 20))
        throw discordRefusal('invalid-history-query');
      if (!route || !snowflake(route.messageId) || !snowflake(route.actorId)
        || !snowflake(route.conversationId) || route.rootId !== undefined || route.parentId !== undefined
        || (route.threadId !== undefined && !snowflake(route.threadId))) throw discordRefusal('stale-route');
      if (query.scope === 'thread' && !route.threadId) throw discordRefusal('thread-unavailable');
      const sourceRoute = { messageId: route.messageId, actorId: route.actorId,
        conversationId: route.conversationId, ...(route.threadId ? { threadId: route.threadId } : {}) };
      const binding = createHash('sha256').update(JSON.stringify({ botId: identity.botId,
        fingerprint: identity.account.fingerprint, route: sourceRoute,
        scope: query.scope, limit: query.limit,
        ...(query.scope === 'nearby' ? { beforeCount: query.beforeCount ?? 10, afterCount: query.afterCount ?? 5 } : {}) })).digest('hex');
      const state = query.scope === 'nearby' ? nearby.prepare(binding, route, query) : undefined;
      const before = state ? undefined : query.cursor === undefined
        ? String((BigInt(now()) - epoch + 1n) << 22n) : decode(query.cursor, binding);
      if (!state && !snowflake(before)) throw discordRefusal('history-unavailable');
      // HTTP content censorship is independent of the Gateway identify mask. Refuse even on
      // an empty/mention-only page when the native App cannot expose ordinary human content.
      const user = await checked(() => api.getCurrentUser({ signal }));
      const application = await checked(() => api.getCurrentApplication({ signal }));
      const current = verifiedDiscordAccount(user, application);
      if (current.fingerprint !== identity.account.fingerprint) throw discordRefusal('account-changed');
      if (!Number.isSafeInteger(application.flags) || (application.flags & contentFlags) === 0)
        throw discordRefusal('history-permission-denied');
      const sourceChannel = await checked(() => inspectDiscordSourceChannel(api,
        route.threadId ?? route.conversationId, current, signal, { forHistory: true }));
      if (sourceChannel.conversationId !== route.conversationId || sourceChannel.threadId !== route.threadId)
        throw discordRefusal('stale-route');
      const source = await checked(() => api.getMessage({ channelId: sourceChannel.channelId,
        messageId: route.messageId, signal }));
      if (source?.id !== route.messageId || source.channel_id !== sourceChannel.channelId
        || (source.guild_id !== undefined && source.guild_id !== sourceChannel.guildId)
        || source.author?.id !== route.actorId || source.author.bot === true || source.webhook_id
        || ![0, 19].includes(source.type)) throw discordRefusal('stale-route');
      const channel = query.scope === 'thread' || query.scope === 'nearby' ? sourceChannel : await checked(() =>
        inspectDiscordSourceChannel(api, route.conversationId, current, signal, { forHistory: true }));
      if (channel.guildId !== sourceChannel.guildId || channel.conversationId !== route.conversationId)
        throw discordRefusal('stale-route');
      const validate = message => {
        if (!snowflake(message?.id) || message.channel_id !== channel.channelId
          || (message.guild_id !== undefined && message.guild_id !== channel.guildId)) throw discordRefusal('stale-route');
      };
      const normalize = message => { validate(message); return normalizeDiscordHistoryText({ ...message, guild_id: channel.guildId },
        { ...identity, channel, eventId: `history:${channel.channelId}:${message.id}` }); };
      const page = async (boundary, limit) => {
        const messages = await checked(() => api.getMessages({ channelId: channel.channelId, before: boundary, limit, signal }));
        if (!Array.isArray(messages) || messages.length > limit) throw discordRefusal('history-unavailable');
        let last = boundary;
        for (const message of messages) { validate(message);
          if (BigInt(message.id) >= BigInt(last)) throw discordRefusal('stale-route');
          last = message.id;
        }
        return messages;
      };
      let result;
      if (state) result = await nearby.read({ binding, state, query, route, source, page, normalize,
        message: async id => {
          let value;
          try { value = await checked(() => api.getMessage({ channelId: channel.channelId, messageId: id, signal })); }
          catch (error) { if (error?.status === 404) return null; throw error; }
          validate(value);
          if (value.id !== id) throw discordRefusal('stale-route');
          return value;
        } });
      else {
        const messages = await page(before, query.limit);
        const events = messages.map(normalize).filter(Boolean);
        const hasMore = messages.length === query.limit;
        result = { version: 1, scope: query.scope, events, omitted: messages.length - events.length,
          hasMore, ...(hasMore ? { nextCursor: encode(binding, messages.at(-1).id) } : {}), coverage };
      }
      // Recheck permission after the HTTP page: Discord can return 200 with no messages
      // on loss of READ_MESSAGE_HISTORY, or censor content on loss of the App flag.
      const finalApp = await checked(() => api.getCurrentApplication({ signal }));
      if (verifiedDiscordAccount(user, finalApp).fingerprint !== identity.account.fingerprint)
        throw discordRefusal('account-changed');
      if (!Number.isSafeInteger(finalApp.flags) || (finalApp.flags & contentFlags) === 0)
        throw discordRefusal('history-permission-denied');
      const finalChannel = await checked(() => inspectDiscordSourceChannel(api,
        channel.channelId, current, signal, { forHistory: true }));
      if (finalChannel.guildId !== channel.guildId || finalChannel.conversationId !== channel.conversationId
        || finalChannel.threadId !== channel.threadId) throw discordRefusal('stale-route');
      check();
      return result;
    } catch (error) {
      check();
      if (['invalid-history-query', 'stale-route', 'account-changed', 'account-unverified',
        'history-permission-denied', 'history-unavailable', 'thread-unavailable', 'cancelled',
        'capability-unavailable'].includes(error?.code)) throw error;
      if (error?.code === 'reply-permission-denied' || error?.status === 401 || error?.status === 403)
        throw discordRefusal('history-permission-denied');
      if (error?.name === 'AbortError') throw discordRefusal('cancelled');
      if (error?.status === 404 && query?.scope === 'thread') throw discordRefusal('thread-unavailable');
      throw discordRefusal('history-unavailable');
    }
  };
}
