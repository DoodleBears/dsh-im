import { createHash } from 'node:crypto';

export function slackRefusal(code) {
  return Object.assign(new Error(code), { code });
}

export function slackTimestamp(value) {
  return typeof value === 'string' && /^\d{10,16}\.\d{6}$/.test(value);
}

function slackId(value, prefix) {
  return typeof value === 'string' && new RegExp(`^[${prefix}][A-Z0-9]{4,30}$`).test(value);
}

export function verifiedSlackAccount(identity, bot) {
  if (!slackId(identity?.team_id, 'T') || !slackId(identity?.user_id, 'UW')
    || !slackId(identity?.bot_id, 'B') || bot?.id !== identity.bot_id
    || bot?.user_id !== identity.user_id || !slackId(bot?.app_id, 'A') || bot.deleted === true)
    throw slackRefusal('account-unverified');
  const account = { teamId: identity.team_id, userId: identity.user_id,
    botId: identity.bot_id, appId: bot.app_id };
  return Object.freeze({ ...account,
    fingerprint: createHash('sha256').update(JSON.stringify({ provider: 'slack', ...account })).digest('hex'),
    ...(typeof bot.name === 'string' && bot.name ? { name: bot.name.slice(0, 512) } : {}),
  });
}

/** Native channel and timestamp identities stay separate from event delivery IDs. */
export function normalizeSlackExternalText(payload, { botId, account, sourceFiles = false }) {
  if (payload?.api_app_id !== account.appId || payload?.team_id !== account.teamId)
    throw slackRefusal('account-changed');
  const event = payload.event;
  if (event?.type !== 'app_mention' || event.bot_id || event.app_id || (event.subtype && !(sourceFiles && event.subtype === 'file_share'))
    || (!sourceFiles && Array.isArray(event.files) && event.files.length > 0)
    || event.user === account.userId) return null;
  if (!slackId(event.channel, 'C') || !slackId(event.user, 'UW')
    || !slackTimestamp(event.ts) || (event.thread_ts !== undefined && !slackTimestamp(event.thread_ts))
    || typeof payload.event_id !== 'string' || !/^Ev[A-Za-z0-9]{4,126}$/.test(payload.event_id)
    || typeof event.text !== 'string' || !event.text.trim() || event.text.length > 16000) throw slackRefusal('invalid-inbound');
  return normalizeText(event, { botId, account, eventId: payload.event_id, requireMention: true });
}

function normalizeText(event, { botId, account, eventId, requireMention }) {
  const mentions = [...event.text.matchAll(/<@([UW][A-Z0-9]{4,30})>/g)]
    .map(([key, id]) => Object.freeze({ key, id,
      ...(id === account.userId && account.name ? { name: account.name } : {}) }));
  if (mentions.length > 100) throw slackRefusal('invalid-inbound');
  const mentionedAccount = mentions.some(mention => mention.id === account.userId);
  if (requireMention && !mentionedAccount) return null;
  const at = new Date(Number(event.ts) * 1000);
  if (!Number.isFinite(at.getTime())) throw slackRefusal('invalid-inbound');
  const threadId = event.thread_ts ?? event.ts;
  return Object.freeze({ version: 1, channel: 'slack', botId, fingerprint: account.fingerprint,
    eventId: eventId, messageId: event.ts,
    actor: Object.freeze({ kind: 'user', id: event.user }),
    conversation: Object.freeze({ kind: 'group', id: event.channel }),
    mentions: Object.freeze(mentions), mentionedAccount, at: at.toISOString(), text: event.text,
    reply: Object.freeze({ messageId: event.ts, conversationId: event.channel, actorId: event.user,
      threadId, rootId: threadId }),
    replay: Object.freeze({ kind: 'provider-redelivery', resumeCursor: false, gapPossible: true }),
  });
}

/** A historical read is evidence, never a Socket delivery or an Inbox admission. */
export function normalizeSlackHistoryText(message, { botId, account, conversationId }) {
  if (message?.type !== 'message' || message.deleted === true || message.bot_id || message.app_id || message.subtype
    || (Array.isArray(message.files) && message.files.length > 0)
    || message.user === account.userId) return null;
  if (!slackId(message.user, 'UW') || !slackTimestamp(message.ts)
    || (message.thread_ts !== undefined && !slackTimestamp(message.thread_ts))
    || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 16000)
    return null;
  return normalizeText({ ...message, channel: conversationId }, { botId, account,
    eventId: `history:${conversationId}:${message.ts}`, requireMention: false });
}
