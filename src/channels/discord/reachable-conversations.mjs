import { discordRefusal, discordSnowflake, discordChannelPermissions, sendDiscordCheckedText } from './external-consumer.mjs';

const REQUIRED = (1n << 10n) | (1n << 11n);
function canSpeak(guild, member, channel, account) {
  if (!discordSnowflake(channel?.id) || ![0, 5].includes(channel.type)) return false;
  if (member?.communication_disabled_until != null) {
    const until = Date.parse(member.communication_disabled_until);
    if (!Number.isFinite(until) || until > Date.now()) return false;
  }
  return (discordChannelPermissions(guild, member, channel, account.userId) & REQUIRED) === REQUIRED;
}
function failure(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError') return discordRefusal('cancelled');
  if (['bad-request', 'send-permission-denied', 'account-changed', 'capability-unavailable'].includes(error?.code)) return error;
  if ([401, 403, 404].includes(error?.status)) return discordRefusal('send-permission-denied');
  return discordRefusal('send-preflight-unavailable');
}
function cursorOf(cursor) {
  if (cursor === undefined) return { offset: 0 };
  if (typeof cursor !== 'string' || cursor.length > 100) throw discordRefusal('bad-request');
  const match = /^(0|[0-9]{5,30}):([0-4]00|0)$/.exec(cursor);
  if (!match) throw discordRefusal('bad-request');
  return { ...(match[1] === '0' ? {} : { after: match[1] }), offset: Number(match[2]) };
}
function nameOf(guild, channel) {
  return `${typeof guild.name === 'string' ? guild.name : guild.id} #${typeof channel.name === 'string' ? channel.name : channel.id}`.slice(0, 512);
}

/** One bounded page of guild channels; no history permission or saved target is needed. */
export async function listDiscordReachable(checked, cursor) {
  const { api, account, signal, assertCurrent } = checked;
  const { after, offset } = cursorOf(cursor);
  try {
    assertCurrent();
    const guilds = await api.getCurrentGuilds({ after, signal });
    if (!Array.isArray(guilds) || guilds.length > 2 || !guilds.every(guild => discordSnowflake(guild?.id)))
      throw discordRefusal('send-preflight-unavailable');
    if (!guilds.length) return { version: 1, conversations: [], hasMore: false };
    const guildId = guilds[0].id;
    const [guild, member, channels] = await Promise.all([
      api.getGuild({ guildId, signal }), api.getGuildMember({ guildId, userId: account.userId, signal }),
      api.getGuildChannels({ guildId, signal }),
    ]);
    assertCurrent();
    if (guild?.id !== guildId || !Array.isArray(channels) || channels.length > 500)
      throw discordRefusal('send-preflight-unavailable');
    const conversations = channels.slice(offset, offset + 100).filter(channel => canSpeak(guild, member, channel, account))
      .map(channel => ({ id: channel.id, kind: 'group', name: nameOf(guild, channel) }));
    const next = offset + 100 < channels.length ? `${after ?? '0'}:${offset + 100}`
      : guilds.length > 1 ? `${guildId}:0` : undefined;
    return { version: 1, conversations, hasMore: next !== undefined, ...(next ? { cursor: next } : {}) };
  } catch (error) { throw failure(error, signal); }
}

export async function postDiscordReachable(checked, conversationId, text, options) {
  const { api, account, signal, assertCurrent } = checked;
  if (!discordSnowflake(conversationId)) throw discordRefusal('bad-request');
  let channel;
  try {
    assertCurrent();
    channel = await api.getChannel({ channelId: conversationId, signal });
    if (channel?.id !== conversationId || !discordSnowflake(channel.guild_id)) throw discordRefusal('send-permission-denied');
    const [guild, member] = await Promise.all([
      api.getGuild({ guildId: channel.guild_id, signal }),
      api.getGuildMember({ guildId: channel.guild_id, userId: account.userId, signal }),
    ]);
    assertCurrent();
    if (!canSpeak(guild, member, channel, account)) throw discordRefusal('send-permission-denied');
  } catch (error) { throw failure(error, signal); }
  if (options.beforeSend() !== true) throw discordRefusal('send-permission-denied');
  assertCurrent();
  try {
    return await sendDiscordCheckedText(api, account, { channelId: conversationId, conversationId }, text, { signal, receipt: true });
  } catch (error) {
    if (error?.code === 'reply-permission-denied') throw discordRefusal('send-permission-denied');
    if (error?.code === 'reply-result-unknown') throw discordRefusal('send-result-unknown');
    throw error;
  }
}
