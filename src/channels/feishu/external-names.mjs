function displayName(value) {
  return typeof value === 'string' && value.trim() && value.length <= 512 ? value.trim() : undefined;
}

export async function externalSenderName(client, evidence, { signal, timeoutMs = 1500 } = {}) {
  signal?.throwIfAborted();
  if (displayName(evidence.actor.name)) return evidence;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('metadata-timeout')), timeoutMs);
  try {
    const response = await Promise.race([
      client.im.v1.message.get({ path: { message_id: evidence.messageId }, params: { with_sender_name: true } }, { signal: controller.signal }),
      aborted,
    ]);
    signal?.throwIfAborted();
    const route = evidence.reply;
    const source = response?.data?.items?.find(item => item.message_id === evidence.messageId);
    if (response?.code || !source || source.deleted === true || source.msg_type !== 'text'
      || source.chat_id !== route.conversationId
      || source.sender?.sender_type !== 'user' || source.sender?.id_type !== 'open_id'
      || source.sender?.id !== evidence.actor.id
      || (source.thread_id || undefined) !== route.threadId
      || (source.root_id || undefined) !== route.rootId
      || (source.parent_id || undefined) !== route.parentId) return evidence;
    if (JSON.parse(source.body?.content)?.text !== evidence.text) return evidence;
    const name = displayName(source.sender.sender_name);
    return name ? Object.freeze({ ...evidence, actor: Object.freeze({ ...evidence.actor, name }) }) : evidence;
  } catch {
    signal?.throwIfAborted();
    return evidence;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
