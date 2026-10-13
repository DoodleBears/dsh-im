import { createHash } from 'node:crypto';

export function discordRefusal(code) { return Object.assign(new Error(code), { code }); }
export function discordSnowflake(value) { return typeof value === 'string' && /^[0-9]{5,30}$/.test(value); }
const PUBLIC_THREAD = 11;
const TEXT_CHANNEL = 0;
const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const ATTACH = 1n << 15n;
const HISTORY = 1n << 16n;
const THREAD_SEND = 1n << 38n;
const ADMIN = 1n << 3n;

export function verifiedDiscordAccount(user, application) {
  if (!discordSnowflake(user?.id) || user.bot !== true || !discordSnowflake(application?.id)
    || application.bot?.id !== user.id)
    throw discordRefusal('account-unverified');
  const identity = { appId: application.id, userId: user.id };
  return Object.freeze({ ...identity,
    name: [user.global_name, user.username, application.name].find(value => typeof value === 'string' && value.trim()) ?? user.id,
    fingerprint: createHash('sha256').update(JSON.stringify({ provider: 'discord', ...identity })).digest('hex'),
  });
}

function bits(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw discordRefusal('reply-permission-denied');
  return BigInt(value);
}

/** Official overwrite order: everyone, union of member roles, then the member. */
export function discordChannelPermissions(guild, member, channel, userId) {
  if (!discordSnowflake(guild?.id) || channel?.guild_id !== guild.id || member?.user?.id !== userId
    || !Array.isArray(guild.roles) || !Array.isArray(member.roles)
    || !Array.isArray(channel.permission_overwrites)) throw discordRefusal('reply-permission-denied');
  const everyone = guild.roles.find(role => role.id === guild.id);
  if (!everyone) throw discordRefusal('reply-permission-denied');
  let permissions = bits(everyone.permissions);
  for (const id of member.roles) {
    const role = guild.roles.find(candidate => candidate.id === id);
    if (!role) throw discordRefusal('reply-permission-denied');
    permissions |= bits(role.permissions);
  }
  if (guild.owner_id === userId || (permissions & ADMIN) !== 0n) return ~0n;
  const apply = overwrite => {
    if (overwrite) permissions = (permissions & ~bits(overwrite.deny)) | bits(overwrite.allow);
  };
  apply(channel.permission_overwrites.find(row => row.type === 0 && row.id === guild.id));
  let allow = 0n; let deny = 0n;
  for (const row of channel.permission_overwrites) {
    if (row.type === 0 && member.roles.includes(row.id)) { allow |= bits(row.allow); deny |= bits(row.deny); }
  }
  permissions = (permissions & ~deny) | allow;
  apply(channel.permission_overwrites.find(row => row.type === 1 && row.id === userId));
  return permissions;
}

function nativeFailure(error, missing) {
  if (error?.code && ['stale-route', 'reply-permission-denied', 'cancelled'].includes(error.code)) return error;
  if (error?.status === 404) return discordRefusal(missing);
  if (error?.status === 401 || error?.status === 403) return discordRefusal('reply-permission-denied');
  if (error?.name === 'AbortError') return discordRefusal('cancelled');
  return discordRefusal('source-unavailable');
}

/** Only one guild text channel and its existing public threads; no channel creation. */
export async function inspectDiscordSourceChannel(api, channelId, account, signal, { forReply = false, forHistory = false, forFileReply = false } = {}) {
  if (!discordSnowflake(channelId)) throw discordRefusal('stale-route');
  signal?.throwIfAborted();
  try {
    const channel = await api.getChannel({ channelId, signal });
    if (channel?.id !== channelId || !discordSnowflake(channel.guild_id)) throw discordRefusal('stale-route');
    const isThread = channel.type === PUBLIC_THREAD;
    if (channel.type !== TEXT_CHANNEL && !isThread) throw discordRefusal('reply-permission-denied');
    const parent = isThread ? await api.getChannel({ channelId: channel.parent_id, signal }) : channel;
    if (parent?.type !== TEXT_CHANNEL || parent.guild_id !== channel.guild_id
      || (isThread && (parent.id !== channel.parent_id || parent.id === channel.id))) throw discordRefusal('stale-route');
    if (isThread && !forHistory && (!channel.thread_metadata || channel.thread_metadata.archived !== false
      || channel.thread_metadata.locked !== false)) throw discordRefusal('reply-permission-denied');
    const [guild, member] = await Promise.all([
      api.getGuild({ guildId: channel.guild_id, signal }),
      api.getGuildMember({ guildId: channel.guild_id, userId: account.userId, signal }),
    ]);
    if (guild?.id !== channel.guild_id) throw discordRefusal('stale-route');
    const permissions = discordChannelPermissions(guild, member, parent, account.userId);
    const required = (forFileReply ? ATTACH : 0n) | VIEW | (forHistory ? HISTORY : 0n) | (forReply ? HISTORY | (isThread ? THREAD_SEND : SEND) : 0n);
    if ((permissions & required) !== required) throw discordRefusal('reply-permission-denied');
    if (forReply && member.communication_disabled_until && Date.parse(member.communication_disabled_until) > Date.now())
      throw discordRefusal('reply-permission-denied');
    signal?.throwIfAborted();
    const name = [guild.name, parent.name].every(value => typeof value === 'string' && value.trim())
      ? `${guild.name.trim()} #${parent.name.trim()}`.slice(0, 512) : undefined;
    return { guildId: guild.id, conversationId: parent.id, channelId: channel.id, ...(name ? { name } : {}),
      ...(isThread ? { threadId: channel.id } : {}) };
  } catch (error) { throw nativeFailure(error, 'source-not-found'); }
}

export function discordMessageContentAllowed(application) {
  let flags;
  if (application?.flags_new !== undefined) {
    if (typeof application.flags_new !== 'string' || !/^[0-9]{1,128}$/.test(application.flags_new)) return false;
    flags = BigInt(application.flags_new);
  } else {
    if (!Number.isSafeInteger(application?.flags) || application.flags < 0) return false;
    flags = BigInt(application.flags);
  }
  return (flags & ((1n << 18n) | (1n << 19n))) !== 0n;
}

export function normalizeDiscordExternalText(message, { botId, account, channel, eventId, ordinaryText = false }) {
  return normalizeDiscordHumanText(message, { botId, account, channel, eventId }, ordinaryText !== true);
}

/** History visibility never relaxes the mention-only live admission predicate. */
export function normalizeDiscordHistoryText(message, identity) {
  return normalizeDiscordHumanText(message, identity, false);
}

function normalizeDiscordHumanText(message, { botId, account, channel, eventId }, requireMention) {
  if (!discordSnowflake(message?.id) || !discordSnowflake(message?.author?.id)
    || message.author.bot === true || message.webhook_id || message.author.id === account.userId
    || ![0, 19].includes(message.type) || typeof message.content !== 'string' || !message.content.trim()
    || message.content.length > 16000 || !Array.isArray(message.mentions)) return null;
  if (message.guild_id !== channel.guildId || message.channel_id !== channel.channelId)
    throw discordRefusal('stale-route');
  const mentionedAccount = message.mentions.some(user => user.id === account.userId);
  if (requireMention && !mentionedAccount) return null;
  const timestamp = Date.parse(message.timestamp);
  if (!Number.isFinite(timestamp) || typeof eventId !== 'string' || !eventId || eventId.length > 512)
    throw discordRefusal('invalid-inbound');
  const name = [message.member?.nick, message.author.global_name, message.author.username]
    .find(value => typeof value === 'string' && value.trim());
  const mentions = message.mentions.filter(user => discordSnowflake(user.id)).slice(0, 100)
    .map(user => ({ id: user.id, key: `<@${user.id}>`,
      ...(user.id === account.userId ? { name: account.name } : {}) }));
  return { version: 1, channel: 'discord', botId, fingerprint: account.fingerprint,
    eventId, messageId: message.id, actor: { kind: 'user', id: message.author.id, ...(name ? { name: name.slice(0, 512) } : {}) },
    conversation: { kind: 'group', id: channel.conversationId, ...(channel.name ? { name: channel.name } : {}) }, mentions, mentionedAccount,
    at: new Date(timestamp).toISOString(), text: message.content,
    reply: { messageId: message.id, conversationId: channel.conversationId, actorId: message.author.id,
      ...(channel.threadId ? { threadId: channel.threadId } : {}) },
    replay: { kind: 'provider-redelivery', resumeCursor: false, gapPossible: true },
  };
}

export async function qualifyDiscordReply(api, account, route, signal, permissions = { forReply: true }) {
  if (!route || !discordSnowflake(route.messageId) || !discordSnowflake(route.actorId)
    || !discordSnowflake(route.conversationId) || route.rootId !== undefined || route.parentId !== undefined
    || (route.threadId !== undefined && !discordSnowflake(route.threadId))) throw discordRefusal('stale-route');
  const channel = await inspectDiscordSourceChannel(api, route.threadId ?? route.conversationId, account, signal, permissions);
  if (channel.conversationId !== route.conversationId || channel.threadId !== route.threadId)
    throw discordRefusal('stale-route');
  let source;
  try { source = await api.getMessage({ channelId: channel.channelId, messageId: route.messageId, signal }); }
  catch (error) { throw nativeFailure(error, 'source-not-found'); }
  if (source?.id !== route.messageId || source.channel_id !== channel.channelId
    || source.author?.id !== route.actorId || source.author.bot === true || source.webhook_id
    || ![0, 19].includes(source.type)) throw discordRefusal('stale-route');
  signal?.throwIfAborted();
  return { channel, route: { ...route }, source };
}

/** Only the source author or people the source message mentions may be pinged back. */
export function discordReplyMentions(mentionUserIds, route, source) {
  if (mentionUserIds === undefined) return [];
  if (!Array.isArray(mentionUserIds) || mentionUserIds.length > 20
    || !mentionUserIds.every(discordSnowflake)) throw discordRefusal('bad-request');
  const allowed = new Set([route.actorId, ...(Array.isArray(source?.mentions) ? source.mentions.map(user => user?.id) : [])]);
  if (!mentionUserIds.every(id => allowed.has(id))) throw discordRefusal('bad-request');
  return [...new Set(mentionUserIds)];
}

export async function sendDiscordReply(api, account, route, text, { signal, beforeSend, assertCurrent = () => {}, receipt = false, mentionUserIds } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw discordRefusal('bad-request');
  const checked = await qualifyDiscordReply(api, account, route, signal);
  const mentions = discordReplyMentions(mentionUserIds, route, checked.source);
  if (mentions.length * 23 + text.length > 2000) throw discordRefusal('bad-request');
  signal?.throwIfAborted();
  assertCurrent();
  if (beforeSend && beforeSend() !== true) throw discordRefusal('stale-route');
  signal?.throwIfAborted();
  return sendDiscordCheckedText(api, account, checked.channel, text, { signal, receipt, replyToMessageId: route.messageId,
    ...(mentions.length ? { mentionUserIds: mentions } : {}) });
}

export async function sendDiscordCheckedText(api, account, channel, text, { signal, receipt = false, replyToMessageId, mentionUserIds } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw discordRefusal('bad-request');
  let sent;
  try {
    sent = await api.createMessage({ channelId: channel.channelId, content: text,
      replyToMessageId, ...(mentionUserIds ? { mentionUserIds } : {}), signal, retry: false, failIfNotExists: true });
  } catch (error) {
    if ([400, 401, 403, 404, 429].includes(error?.status)) throw discordRefusal('reply-permission-denied');
    throw discordRefusal('reply-result-unknown');
  }
  if (!discordSnowflake(sent?.id) || sent.channel_id !== channel.channelId
    || sent.author?.id !== account.userId || sent.author.bot !== true)
    throw discordRefusal('reply-result-unknown');
  return { sent: true, ...(receipt ? { receipt: { version: 1, messageId: sent.id, conversationId: channel.conversationId } } : {}) };
}
