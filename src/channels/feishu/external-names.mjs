const NAME_TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
const CACHE_LIMIT = 1000;

function displayName(value) {
  return typeof value === 'string' && value.trim() && value.length <= 512 ? value.trim() : undefined;
}

/** Display names are presentation only; a bounded per-account cache keeps them off the delivery path. */
export function createExternalNameCache({ now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) { entries.delete(key); return undefined; }
      return entry;
    },
    set(key, name) {
      entries.delete(key);
      entries.set(key, { name, expiresAt: now() + (name ? NAME_TTL_MS : MISS_TTL_MS) });
      while (entries.size > CACHE_LIMIT) entries.delete(entries.keys().next().value);
    },
  };
}

async function bounded(signal, timeoutMs, lookup) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('metadata-timeout')), timeoutMs);
  try {
    const result = await Promise.race([lookup(controller.signal), aborted]);
    signal?.throwIfAborted();
    return result;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

function withActorName(evidence, name) {
  return name ? Object.freeze({ ...evidence, actor: Object.freeze({ ...evidence.actor, name }) }) : evidence;
}

export async function externalSenderName(client, evidence, { signal, timeoutMs = 3000, cache } = {}) {
  signal?.throwIfAborted();
  if (displayName(evidence.actor.name)) return evidence;
  const cached = cache?.get(`sender:${evidence.actor.id}`);
  if (cached) return withActorName(evidence, cached.name);
  const name = await bounded(signal, timeoutMs, async lookupSignal => {
    const response = await client.im.v1.message.get(
      { path: { message_id: evidence.messageId }, params: { with_sender_name: true } }, { signal: lookupSignal });
    const route = evidence.reply;
    const source = response?.data?.items?.find(item => item.message_id === evidence.messageId);
    if (response?.code || !source || source.deleted === true || source.msg_type !== 'text'
      || source.chat_id !== route.conversationId
      || source.sender?.sender_type !== 'user' || source.sender?.id_type !== 'open_id'
      || source.sender?.id !== evidence.actor.id
      || (source.thread_id || undefined) !== route.threadId
      || (source.root_id || undefined) !== route.rootId
      || (source.parent_id || undefined) !== route.parentId) return undefined;
    if (JSON.parse(source.body?.content)?.text !== evidence.text) return undefined;
    return displayName(source.sender.sender_name);
  });
  if (name) cache?.set(`sender:${evidence.actor.id}`, name);
  return withActorName(evidence, name);
}

export async function externalConversationName(client, evidence, { signal, timeoutMs = 3000, cache } = {}) {
  signal?.throwIfAborted();
  if (evidence.conversation?.kind !== 'group' || displayName(evidence.conversation.name)) return evidence;
  const key = `chat:${evidence.conversation.id}`;
  const cached = cache?.get(key);
  const name = cached ? cached.name : await bounded(signal, timeoutMs, async lookupSignal => {
    const response = await client.im.v1.chat.get({ path: { chat_id: evidence.conversation.id } }, { signal: lookupSignal });
    return response?.code ? undefined : displayName(response?.data?.name);
  });
  if (!cached) cache?.set(key, name);
  return name ? Object.freeze({ ...evidence, conversation: Object.freeze({ ...evidence.conversation, name }) }) : evidence;
}

export async function externalNames(client, evidence, options = {}) {
  const [sender, conversation] = await Promise.all([
    externalSenderName(client, evidence, options),
    externalConversationName(client, evidence, options),
  ]);
  return conversation === evidence ? sender
    : sender === evidence ? conversation : Object.freeze({ ...sender, conversation: conversation.conversation });
}
