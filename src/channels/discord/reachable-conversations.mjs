import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  discordChannelPermissions,
  discordRefusal,
  discordSnowflake,
  sendDiscordCheckedText,
} from './external-consumer.mjs';

const REQUIRED = (1n << 10n) | (1n << 11n);
const MESSAGE_CHANNELS = new Set([0, 2, 5, 13]);
const denied = (error) =>
  [401, 403, 404].includes(error?.status) ||
  ['reply-permission-denied', 'send-permission-denied'].includes(error?.code);

function preflightFailure(error, checked) {
  if (checked.signal.aborted) return discordRefusal('cancelled');
  if (['capability-unavailable', 'cancelled', 'bad-request'].includes(error?.code)) return error;
  return discordRefusal(denied(error) ? 'send-permission-denied' : 'send-preflight-unavailable');
}

function canSpeak(guild, member, channel, account) {
  if (
    !MESSAGE_CHANNELS.has(channel?.type) ||
    !discordSnowflake(channel.id) ||
    channel.guild_id !== guild.id
  )
    return false;
  if (member.communication_disabled_until) {
    const until = Date.parse(member.communication_disabled_until);
    if (!Number.isFinite(until) || until > Date.now()) return false;
  }
  return (
    (discordChannelPermissions(guild, member, channel, account.userId) & REQUIRED) === REQUIRED
  );
}

export function createDiscordReachable() {
  const secret = randomBytes(32);
  const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url');
  const encode = (state, account) => {
    const payload = Buffer.from(
      JSON.stringify({ ...state, user: account.userId, expires: Date.now() + 15 * 60_000 }),
    ).toString('base64url');
    return `${payload}.${sign(payload)}`;
  };
  const decode = (cursor, account) => {
    if (cursor === undefined) return { after: undefined, guild: 0, channel: 0 };
    if (
      typeof cursor !== 'string' ||
      cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)
    )
      throw discordRefusal('bad-request');
    const [payload, signature] = cursor.split('.');
    const expected = sign(payload);
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw discordRefusal('bad-request');
    let state;
    try {
      state = JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch {
      throw discordRefusal('bad-request');
    }
    if (
      state.user !== account.userId ||
      !Number.isSafeInteger(state.expires) ||
      state.expires <= Date.now() ||
      (state.after !== undefined && !discordSnowflake(state.after)) ||
      !Number.isSafeInteger(state.guild) ||
      state.guild < 0 ||
      state.guild >= 100 ||
      !Number.isSafeInteger(state.channel) ||
      state.channel < 0 ||
      state.channel > 500
    )
      throw discordRefusal('bad-request');
    return state;
  };
  return {
    async list(checked, { cursor } = {}) {
      const state = decode(cursor, checked.account);
      try {
        checked.assertCurrent();
        const guilds = await checked.api.listCurrentGuilds({
          after: state.after,
          limit: 100,
          signal: checked.signal,
        });
        checked.assertCurrent();
        if (
          !Array.isArray(guilds) ||
          guilds.length > 100 ||
          guilds.some((g) => !discordSnowflake(g?.id))
        )
          throw discordRefusal('send-preflight-unavailable');
        const conversations = [];
        for (let gi = state.guild; gi < guilds.length; gi++) {
          const guildId = guilds[gi].id;
          let guild, member, channels;
          try {
            [guild, member, channels] = await Promise.all([
              checked.api.getGuild({ guildId, signal: checked.signal }),
              checked.api.getGuildMember({
                guildId,
                userId: checked.account.userId,
                signal: checked.signal,
              }),
              checked.api.getGuildChannels({ guildId, signal: checked.signal }),
            ]);
          } catch (error) {
            if (denied(error)) continue;
            throw error;
          }
          checked.assertCurrent();
          if (guild?.id !== guildId || !Array.isArray(channels) || channels.length > 500)
            throw discordRefusal('send-preflight-unavailable');
          for (let ci = gi === state.guild ? state.channel : 0; ci < channels.length; ci++) {
            if (!canSpeak(guild, member, channels[ci], checked.account)) continue;
            const channel = channels[ci];
            conversations.push({
              id: channel.id,
              kind: 'group',
              name: `${guilds[gi].name || guildId} / ${channel.name || channel.id}`,
            });
            if (conversations.length === 100) {
              const next =
                ci + 1 < channels.length
                  ? { after: state.after, guild: gi, channel: ci + 1 }
                  : gi + 1 < guilds.length
                    ? { after: state.after, guild: gi + 1, channel: 0 }
                    : guilds.length === 100
                      ? { after: guilds.at(-1).id, guild: 0, channel: 0 }
                      : undefined;
              checked.assertCurrent();
              return {
                version: 1,
                conversations,
                hasMore: !!next,
                ...(next ? { cursor: encode(next, checked.account) } : {}),
              };
            }
          }
        }
        checked.assertCurrent();
        if (guilds.length === 100 && guilds.at(-1).id === state.after)
          throw discordRefusal('send-preflight-unavailable');
        return {
          version: 1,
          conversations,
          hasMore: guilds.length === 100,
          ...(guilds.length === 100
            ? { cursor: encode({ after: guilds.at(-1).id, guild: 0, channel: 0 }, checked.account) }
            : {}),
        };
      } catch (error) {
        throw preflightFailure(error, checked);
      }
    },
    async post(checked, id, text, { beforeSend } = {}) {
      if (
        !discordSnowflake(id) ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 2000 ||
        typeof beforeSend !== 'function'
      )
        throw discordRefusal('bad-request');
      try {
        checked.assertCurrent();
        const channel = await checked.api.getChannel({ channelId: id, signal: checked.signal });
        checked.assertCurrent();
        if (channel?.id !== id || !discordSnowflake(channel.guild_id))
          throw discordRefusal('send-permission-denied');
        const [guild, member] = await Promise.all([
          checked.api.getGuild({ guildId: channel.guild_id, signal: checked.signal }),
          checked.api.getGuildMember({
            guildId: channel.guild_id,
            userId: checked.account.userId,
            signal: checked.signal,
          }),
        ]);
        checked.assertCurrent();
        if (guild?.id !== channel.guild_id || !canSpeak(guild, member, channel, checked.account))
          throw discordRefusal('send-permission-denied');
      } catch (error) {
        throw preflightFailure(error, checked);
      }
      checked.assertCurrent();
      if (beforeSend() !== true) throw discordRefusal('send-permission-denied');
      checked.assertCurrent();
      try {
        return await sendDiscordCheckedText(
          checked.api,
          checked.account,
          { channelId: id, conversationId: id },
          text,
          { signal: checked.signal, receipt: true },
        );
      } catch (error) {
        throw discordRefusal(
          error?.code === 'reply-permission-denied'
            ? 'send-permission-denied'
            : 'send-result-unknown',
        );
      }
    },
  };
}
