import { slackRefusal } from './external-consumer.mjs';

function permitted(channel, account) {
  if (!/^[CG][A-Z0-9]{4,30}$/.test(channel?.id ?? '') || channel.is_member !== true
    || channel.is_archived === true || channel.is_frozen === true || channel.is_read_only === true
    || channel.is_im === true || channel.is_mpim === true) return false;
  const restricted = channel.properties?.posting_restricted_to;
  if (restricted === undefined || restricted === null) return true;
  if (typeof restricted !== 'object' || Array.isArray(restricted)) return false;
  for (const key of Object.keys(restricted)) {
    if (!['user', 'subteam', 'type'].includes(key) || !Array.isArray(restricted[key])) return false;
  }
  if (restricted.user?.includes(account.userId)) return true;
  return ['user', 'subteam', 'type'].every(key => (restricted[key] ?? []).length === 0);
}
function failure(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError') return slackRefusal('cancelled');
  if (['bad-request', 'send-permission-denied', 'account-changed', 'capability-unavailable'].includes(error?.code)) return error;
  if (['missing_scope', 'not_in_channel', 'channel_not_found', 'is_archived', 'no_permission'].includes(error?.providerCode))
    return slackRefusal('send-permission-denied');
  return slackRefusal('send-preflight-unavailable');
}
async function inspect(checked, conversationId) {
  const { api, account, signal, assertCurrent } = checked;
  const channel = await api.conversationInfo({ channelId: conversationId, signal });
  assertCurrent();
  if (channel?.id !== conversationId || !permitted(channel, account)) throw slackRefusal('send-permission-denied');
  if (api.hasBotScope('chat:write') !== true) throw slackRefusal('send-permission-denied');
  return channel;
}

export async function listSlackReachable(checked, cursor) {
  const { api, signal, assertCurrent } = checked;
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 1800)) throw slackRefusal('bad-request');
  try {
    assertCurrent();
    const page = await api.joinedConversations({ cursor, signal });
    assertCurrent();
    if (!Array.isArray(page?.channels) || page.channels.length > 20) throw slackRefusal('send-preflight-unavailable');
    const conversations = [];
    for (const candidate of page.channels) {
      if (!/^[CG][A-Z0-9]{4,30}$/.test(candidate?.id ?? '') || candidate.is_im || candidate.is_mpim) continue;
      let channel;
      try { channel = await inspect(checked, candidate.id); }
      catch (error) { if (error?.code === 'send-permission-denied') continue; throw error; }
      conversations.push({ id: channel.id, kind: 'group', name: `#${channel.name ?? channel.id}`.slice(0, 512) });
    }
    const next = page.response_metadata?.next_cursor;
    if (next !== undefined && (typeof next !== 'string' || next.length > 1800)) throw slackRefusal('send-preflight-unavailable');
    return { version: 1, conversations, hasMore: Boolean(next), ...(next ? { cursor: next } : {}) };
  } catch (error) { throw failure(error, signal); }
}

export async function checkSlackPost(checked, conversationId) {
  if (!/^[CG][A-Z0-9]{4,30}$/.test(conversationId)) throw slackRefusal('bad-request');
  try { await inspect(checked, conversationId); }
  catch (error) { throw failure(error, checked.signal); }
  checked.assertCurrent();
}
