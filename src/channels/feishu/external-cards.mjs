import { qualifyExternalReply } from './reply-context.mjs';

const refuse = (code) => { throw Object.assign(new Error(code), { code }); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identifier = (value, prefix) => typeof value === 'string' && value.length <= 512 && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

export function externalApprovalCard(value) {
  if (!value || !uuid.test(value.requestId ?? '') || !text(value.title, 120) || !text(value.detail, 16000)
    || !['pending', 'web-required', 'allowed-once', 'rejected', 'expired', 'executed', 'execution-failed', 'execution-unknown', 'test'].includes(value.status)) refuse('bad-request');
  const elements = [{ tag: 'div', text: { tag: 'plain_text', content: value.detail } }];
  if (value.status === 'pending') elements.push({ tag: 'action', actions: [
    { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'Allow once / 允许一次' }, value: { namespace: 'botharness/approval-v1', requestId: value.requestId, action: 'allowed-once' } },
    { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: 'Reject / 拒绝' }, value: { namespace: 'botharness/approval-v1', requestId: value.requestId, action: 'rejected' } },
  ] });
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: value.title }, template: 'blue' }, elements });
}

export function normalizeExternalCardAction(event, identity) {
  const appId = event?.header?.app_id ?? event?.app_id;
  if (appId !== undefined && appId !== identity.appId) refuse('account-changed');
  const value = event?.action?.value;
  if (value?.namespace !== 'botharness/approval-v1') return null;
  const actorId = event?.operator?.open_id;
  const messageId = event?.context?.open_message_id;
  const conversationId = event?.context?.open_chat_id;
  if (!identifier(actorId, 'ou') || !identifier(messageId, 'om') || !identifier(conversationId, 'oc')
    || event.action.tag !== 'button' || !uuid.test(value.requestId ?? '')
    || !['allowed-once', 'rejected'].includes(value.action)
    || !/^[a-f0-9]{64}$/.test(identity.fingerprint ?? '')) refuse('invalid-inbound');
  return Object.freeze({ version: 1, channel: 'feishu', botId: identity.botId, fingerprint: identity.fingerprint,
    actorId, messageId, conversationId, requestId: value.requestId, action: value.action });
}

export async function replyExternalApprovalCard(client, route, card, { signal, assertCurrent, beforeSend } = {}) {
  const content = externalApprovalCard(card);
  assertCurrent?.();
  const current = await qualifyExternalReply(client, route, signal);
  if (current.actorId !== route.actorId) refuse('stale-route');
  const chat = await client.im.v1.chat.get({ path: { chat_id: route.conversationId } }, { signal });
  if (chat?.code !== 0 || chat?.data?.chat_mode !== 'p2p') refuse('stale-route');
  assertCurrent?.();
  signal?.throwIfAborted();
  if (typeof beforeSend !== 'function' || beforeSend() !== true) refuse('stale-route');
  const result = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' },
    data: { receive_id: route.conversationId, msg_type: 'interactive', content, uuid: card.requestId } }, { signal });
  if (typeof result?.code !== 'number') refuse('send-result-unknown');
  if (result.code !== 0) refuse('card-provider-rejected');
  if (!identifier(result.data?.message_id, 'om') || result.data?.chat_id !== route.conversationId) refuse('send-result-unknown');
  return { sent: true, receipt: { version: 1, messageId: result.data.message_id, conversationId: result.data.chat_id } };
}

export async function updateExternalApprovalCard(client, identity, receipt, card, { signal, assertCurrent, beforeSend } = {}) {
  const content = externalApprovalCard(card);
  if (!identifier(receipt?.messageId, 'om') || !identifier(receipt?.conversationId, 'oc')) refuse('bad-request');
  assertCurrent?.();
  const result = await client.im.v1.message.get({ path: { message_id: receipt.messageId } }, { signal });
  const source = result?.data?.items?.find(item => item.message_id === receipt.messageId);
  const ownSender = source?.sender?.sender_type === 'app' &&
    ((source.sender.id_type === 'app_id' && source.sender.id === identity.appId) ||
      (source.sender.id_type === 'open_id' && source.sender.id === identity.botOpenId));
  if (result?.code !== 0 || !ownSender || source.deleted || source.chat_id !== receipt.conversationId || source.msg_type !== 'interactive') refuse('stale-route');
  assertCurrent?.();
  signal?.throwIfAborted();
  if (typeof beforeSend !== 'function' || beforeSend() !== true) refuse('stale-route');
  const patched = await client.im.v1.message.patch({ path: { message_id: receipt.messageId }, data: { content } }, { signal });
  if (typeof patched?.code !== 'number') refuse('send-result-unknown');
  if (patched.code !== 0) refuse('card-provider-rejected');
  return { updated: true };
}

export async function consumeExternalCardAction(accept, event, signal, timeoutMs = 2000) {
  const deadline = new AbortController();
  const lifetime = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => accept(event, { signal: lifetime })),
      new Promise((_, reject) => {
        timer = setTimeout(() => { deadline.abort(); reject(new Error('action-deadline')); }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return { toast: { type: 'error', content: 'Request not accepted / 请求未被接受' } };
  } finally { clearTimeout(timer); }
}
