import { slackRefusal, slackTimestamp } from './external-consumer.mjs';

const channelId = (value) => typeof value === 'string' && /^[CG][A-Z0-9]{4,30}$/.test(value);
const denied = (error) =>
  [
    'missing_scope',
    'not_in_channel',
    'channel_not_found',
    'is_archived',
    'no_permission',
    'restricted_action',
    'restricted_action_read_only_channel',
    'access_denied',
  ].includes(error?.providerCode);

function preflightFailure(error, checked) {
  if (checked.signal.aborted) return slackRefusal('cancelled');
  if (
    ['send-permission-denied', 'capability-unavailable', 'cancelled', 'bad-request'].includes(
      error?.code,
    )
  )
    return error;
  return slackRefusal(denied(error) ? 'send-permission-denied' : 'send-preflight-unavailable');
}

function canSpeak(channel, account) {
  if (
    !channelId(channel?.id) ||
    channel.is_member !== true ||
    channel.is_archived === true ||
    channel.is_im === true ||
    channel.is_mpim === true ||
    (channel.is_channel !== true && channel.is_group !== true)
  )
    return false;
  const restriction = channel.properties?.posting_restricted_to;
  if (restriction === undefined) return true;
  if (!restriction || typeof restriction !== 'object') return false;
  for (const field of ['user', 'subteam', 'type']) {
    if (
      restriction[field] !== undefined &&
      (!Array.isArray(restriction[field]) ||
        restriction[field].some((value) => typeof value !== 'string'))
    )
      return false;
  }
  if (restriction.user?.includes(account.userId)) return true;
  return ['user', 'subteam', 'type'].every((field) => !restriction[field]?.length);
}

async function inspect(checked, id) {
  checked.assertCurrent();
  const channel = await checked.api.conversationInfo({ channelId: id, signal: checked.signal });
  checked.assertCurrent();
  const scopes = checked.api.postingScopes();
  if (!(scopes instanceof Set)) throw slackRefusal('send-preflight-unavailable');
  if (!scopes.has('chat:write') || channel?.id !== id || !canSpeak(channel, checked.account))
    throw slackRefusal('send-permission-denied');
  return channel;
}

export async function listSlackReachable(checked, { cursor } = {}) {
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048))
    throw slackRefusal('bad-request');
  try {
    checked.assertCurrent();
    const page = await checked.api.userConversations({
      signal: checked.signal,
      ...(cursor ? { cursor } : {}),
    });
    checked.assertCurrent();
    if (!Array.isArray(page?.channels) || page.channels.length > 100)
      throw slackRefusal('send-preflight-unavailable');
    const conversations = [];
    for (const row of page.channels) {
      if (!channelId(row?.id)) continue;
      try {
        const channel = await inspect(checked, row.id);
        conversations.push({
          id: channel.id,
          kind: 'group',
          name: typeof channel.name === 'string' && channel.name ? channel.name : channel.id,
        });
      } catch (error) {
        if (error?.code !== 'send-permission-denied' && !denied(error)) throw error;
      }
    }
    checked.assertCurrent();
    const next = page.response_metadata?.next_cursor;
    if (next !== undefined && (typeof next !== 'string' || next.length > 2048 || next === cursor))
      throw slackRefusal('send-preflight-unavailable');
    return { version: 1, conversations, hasMore: !!next, ...(next ? { cursor: next } : {}) };
  } catch (error) {
    throw preflightFailure(error, checked);
  }
}

export async function postSlackConversation(checked, id, text, { beforeSend } = {}) {
  if (
    !channelId(id) ||
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > 4000 ||
    typeof beforeSend !== 'function'
  )
    throw slackRefusal('bad-request');
  try {
    await inspect(checked, id);
  } catch (error) {
    throw preflightFailure(error, checked);
  }
  checked.assertCurrent();
  if (beforeSend() !== true) throw slackRefusal('send-permission-denied');
  checked.assertCurrent();
  let sent;
  try {
    sent = await checked.api.postMessage({
      channelId: id,
      text,
      signal: checked.signal,
      retry: false,
    });
  } catch (error) {
    throw slackRefusal(denied(error) ? 'send-permission-denied' : 'send-result-unknown');
  }
  if (
    !slackTimestamp(sent?.ts) ||
    sent.channel !== id ||
    (sent.message?.user !== undefined && sent.message.user !== checked.account.userId) ||
    (sent.message?.bot_id !== undefined && sent.message.bot_id !== checked.account.botId) ||
    (sent.message?.app_id !== undefined && sent.message.app_id !== checked.account.appId)
  )
    throw slackRefusal('send-result-unknown');
  return { sent: true, receipt: { version: 1, messageId: sent.ts, conversationId: id } };
}
