function refuse(code) { throw Object.assign(new Error(code), { code }); }
const fields = ['messageId', 'conversationId', 'actorId'];
const optional = ['threadId', 'rootId', 'parentId'];

export async function qualifyExternalReply(client, route, signal) {
  if (!route || fields.some(key => typeof route[key] !== 'string' || !route[key] || route[key].length > 512)
    || optional.some(key => route[key] !== undefined && (typeof route[key] !== 'string' || !route[key] || route[key].length > 512)))
    refuse('bad-request');
  signal?.throwIfAborted();
  const current = await client.im.v1.message.get({ path: { message_id: route.messageId } }, { signal });
  signal?.throwIfAborted();
  if ([230027, 99991672, 99991679].includes(current?.code)) refuse('reply-permission-denied');
  if (current?.code !== 0 || !Array.isArray(current?.data?.items)) refuse('source-unavailable');
  const source = current?.data?.items?.find(item => item.message_id === route.messageId);
  if (!source || source.deleted) refuse('source-not-found');
  if (source.chat_id !== route.conversationId || source.sender?.sender_type !== 'user'
    || source.sender?.id_type !== 'open_id' || typeof source.sender.id !== 'string' || !source.sender.id
    || optional.some(key => (source[{threadId:'thread_id',rootId:'root_id',parentId:'parent_id'}[key]] || undefined) !== route[key]))
    refuse('stale-route');
  return Object.freeze({ messageId: route.messageId, conversationId: route.conversationId,
    actorId: source.sender.id, ...Object.fromEntries(optional.filter(key => route[key] !== undefined).map(key => [key, route[key]])) });
}
