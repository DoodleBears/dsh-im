import { normalizeExternalText } from './external-consumer.mjs';

function refuse(code) { throw Object.assign(new Error(code), { code }); }
function check(response) {
  if ([230027, 99991672, 99991679].includes(response?.code)) refuse('history-permission-denied');
  if (response?.code) refuse('history-unavailable');
}

// Application-defined checked read: destination is derived from an authenticated source.
// Lark has Chat/time-range listing and Thread listing, not a native around-message API.
export async function readExternalHistory(client, identity, route, query, signal) {
  if (!route || typeof route.messageId !== 'string' || typeof route.conversationId !== 'string'
    || typeof route.actorId !== 'string' || !['group', 'nearby', 'thread'].includes(query?.scope)
    || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 20
    || (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 4096)))
    refuse('bad-request');
  signal?.throwIfAborted();
  const reference = await client.im.v1.message.get({ path: { message_id: route.messageId }, params: { with_sender_name: true } }, { signal });
  check(reference);
  const source = reference?.data?.items?.find(item => item.message_id === route.messageId);
  if (!source || source.deleted || source.chat_id !== route.conversationId
    || source.sender?.sender_type !== 'user' || source.sender?.id_type !== 'open_id'
    || source.sender?.id !== route.actorId || (source.thread_id || undefined) !== route.threadId
    || (source.root_id || undefined) !== route.rootId || (source.parent_id || undefined) !== route.parentId)
    refuse('stale-route');
  if (query.scope === 'thread' && !route.threadId) refuse('thread-unavailable');
  signal?.throwIfAborted();
  const seconds = Math.floor(Number(source.create_time) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) refuse('stale-route');
  const window = query.scope === 'nearby' ? { start: seconds - 300, end: seconds + 301 } : undefined;
  const response = await client.im.v1.message.list({ params: {
    container_id_type: query.scope === 'thread' ? 'thread' : 'chat',
    container_id: query.scope === 'thread' ? route.threadId : route.conversationId,
    sort_type: 'ByCreateTimeDesc', page_size: query.limit, with_sender_name: true,
    ...(query.cursor === undefined ? {} : { page_token: query.cursor }),
    ...(window ? { start_time: String(window.start), end_time: String(window.end) } : {}),
  } }, { signal });
  check(response);
  signal?.throwIfAborted();
  const items = response?.data?.items;
  if (!Array.isArray(items) || items.length > query.limit || typeof response.data.has_more !== 'boolean')
    refuse('history-unavailable');
  const events = [];
  let omitted = 0;
  for (const item of items) {
    if (item.chat_id !== route.conversationId
      || (query.scope === 'thread' && item.thread_id !== route.threadId)) refuse('untrusted-source');
    if (item.deleted || item.msg_type !== 'text' || item.sender?.sender_type !== 'user'
      || item.sender?.id_type !== 'open_id') { ++omitted; continue; }
    const event = normalizeExternalText({ event_id: `history:${item.message_id}`,
      sender: { sender_type: 'user', sender_id: { open_id: item.sender.id }, sender_name: item.sender.sender_name },
      message: { ...item, chat_type: 'group', message_type: item.msg_type, content: item.body?.content,
        mentions: (item.mentions ?? []).map(mention => ({ ...mention, id: { open_id: mention.id } })) },
    }, identity);
    if (!event) { ++omitted; continue; }
    events.push(event);
  }
  const nextCursor = response.data.has_more ? response.data.page_token : undefined;
  if (response.data.has_more && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 4096))
    refuse('history-unavailable');
  return { version: 1, scope: query.scope, events, omitted, hasMore: response.data.has_more,
    ...(nextCursor ? { nextCursor } : {}), ...(window ? { window } : {}),
    coverage: 'provider-visible-human-text' };
}
