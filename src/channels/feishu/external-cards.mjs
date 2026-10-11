import { qualifyExternalReply } from './reply-context.mjs';

const refuse = (code) => { throw Object.assign(new Error(code), { code }); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identifier = (value, prefix) => typeof value === 'string' && value.length <= 512 && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

export function externalApprovalCard(value) {
  if (value?.kind === 'pairing') return externalPairingCard(value);
  if (!value || !uuid.test(value.requestId ?? '') || !text(value.title, 120) || !text(value.detail, 16000)
    || !['pending', 'web-required', 'allowed-once', 'rejected', 'expired', 'executed', 'execution-failed', 'execution-unknown', 'test'].includes(value.status)) refuse('bad-request');
  const elements = [{ tag: 'div', text: { tag: 'plain_text', content: value.detail } }];
  if (value.rules !== undefined && (!Array.isArray(value.rules) || value.rules.length !== 1 || value.rules[0] !== 'exact')) refuse('bad-request');
  if (value.ruleConfirmation !== undefined && (!uuid.test(value.ruleConfirmation.id ?? '') || value.ruleConfirmation.kind !== 'exact')) refuse('bad-request');
  const ruleAction = (action, label, type = 'default') => ({ tag: 'button', type,
    text: { tag: 'plain_text', content: label }, value: { namespace: 'botharness/approval-rule-v1', requestId: value.requestId, action,
      ...(value.ruleConfirmation ? { confirmationId: value.ruleConfirmation.id } : {}) } });
  if (value.status === 'pending' && value.ruleConfirmation) elements.push({ tag: 'action', actions: [
    ruleAction('confirm-exact', 'Confirm matching rule / 确认保存匹配规则', 'primary'),
    ruleAction('cancel-rule', 'Back / 返回'),
  ] });
  else if (value.status === 'pending') elements.push({ tag: 'action', actions: [
    { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'Allow once / 允许一次' }, value: { namespace: 'botharness/approval-v1', requestId: value.requestId, action: 'allowed-once' } },
    { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: 'Reject / 拒绝' }, value: { namespace: 'botharness/approval-v1', requestId: value.requestId, action: 'rejected' } },
    ...(value.rules ? [ruleAction('preview-exact', 'Allow matching operations… / 批准匹配操作…')] : []),
  ] });
  // Both the initial card and later PATCH need shared mode for receiver-visible updates.
  return JSON.stringify({ config: { wide_screen_mode: true, update_multi: true }, header: { title: { tag: 'plain_text', content: value.title }, template: 'blue' }, elements });
}

export function externalPairingCard(value) {
  if (!uuid.test(value?.requestId ?? '') || !text(value.title, 120) || !text(value.detail, 16000)
    || !['pending', 'approved', 'rejected', 'expired', 'unavailable'].includes(value.status)
    || !Array.isArray(value.roles) || value.roles.length > 20
    || value.roles.some(role => !uuid.test(role?.id ?? '') || !text(role.name, 80) || !Number.isSafeInteger(role.revision) || role.revision < 1)
    || !Number.isSafeInteger(value.page) || !Number.isSafeInteger(value.pages) || value.pages < 1 || value.pages > 3 || value.page < 0 || value.page >= value.pages
    || (value.selectedRoleId !== undefined && !uuid.test(value.selectedRoleId))) refuse('bad-request');
  const elements = [{ tag: 'div', text: { tag: 'plain_text', content: value.detail } }];
  const action = (name, label, type = 'default') => ({ tag: 'button', type, text: { tag: 'plain_text', content: label },
    value: { namespace: 'botharness/pairing-v1', requestId: value.requestId, action: name,
      ...(name === 'approve-pairing' ? { roleId: value.selectedRoleId } : {}) } });
  if (value.status === 'pending') {
    if (value.roles.length) elements.push({ tag: 'action', actions: [{ tag: 'select_static',
      placeholder: { tag: 'plain_text', content: `Choose Role / 选择角色 (${value.page + 1}/${value.pages})` },
      options: value.roles.map(role => ({ text: { tag: 'plain_text', content: role.name }, value: role.id })),
      value: { namespace: 'botharness/pairing-v1', requestId: value.requestId, action: 'select-role' } }] });
    const buttons = [];
    if (value.page > 0) buttons.push(action('previous-roles', 'Previous / 上一页'));
    if (value.page + 1 < value.pages) buttons.push(action('next-roles', 'Next / 下一页'));
    if (value.selectedRoleId) buttons.push(action('approve-pairing', 'Approve pairing / 批准配对', 'primary'));
    buttons.push(action('reject-pairing', 'Reject / 拒绝', 'danger'));
    elements.push({ tag: 'action', actions: buttons });
  }
  return JSON.stringify({ config: { wide_screen_mode: true, update_multi: true }, header: { title: { tag: 'plain_text', content: value.title }, template: 'blue' }, elements });
}

export function normalizeExternalCardAction(event, identity) {
  const appId = event?.header?.app_id ?? event?.app_id;
  if (appId !== undefined && appId !== identity.appId) refuse('account-changed');
  const value = event?.action?.value;
  if (!['botharness/approval-v1', 'botharness/pairing-v1', 'botharness/approval-rule-v1'].includes(value?.namespace)) return null;
  const actorId = event?.operator?.open_id;
  const messageId = event?.context?.open_message_id;
  const conversationId = event?.context?.open_chat_id;
  if (!identifier(actorId, 'ou') || !identifier(messageId, 'om') || !identifier(conversationId, 'oc')
    || !uuid.test(value.requestId ?? '')
    || !/^[a-f0-9]{64}$/.test(identity.fingerprint ?? '')) refuse('invalid-inbound');
  if (value.namespace === 'botharness/approval-rule-v1') {
    if (event.action.tag !== 'button' || !['preview-exact', 'confirm-exact', 'cancel-rule'].includes(value.action)
      || (value.action === 'preview-exact' ? value.confirmationId !== undefined : !uuid.test(value.confirmationId ?? ''))) refuse('invalid-inbound');
    return Object.freeze({ kind: 'approval-rule', version: 1, channel: 'feishu', botId: identity.botId, fingerprint: identity.fingerprint,
      actorId, messageId, conversationId, requestId: value.requestId, action: value.action,
      ...(value.confirmationId ? { confirmationId: value.confirmationId } : {}) });
  }
  if (value.namespace === 'botharness/pairing-v1') {
    const roleId = value.action === 'select-role' ? event.action.option : value.roleId;
    if (!['select-role', 'approve-pairing', 'reject-pairing', 'next-roles', 'previous-roles'].includes(value.action)
      || event.action.tag !== (value.action === 'select-role' ? 'select_static' : 'button')
      || (['select-role', 'approve-pairing'].includes(value.action) ? !uuid.test(roleId ?? '') : roleId !== undefined)) refuse('invalid-inbound');
    return Object.freeze({ kind: 'pairing', version: 1, channel: 'feishu', botId: identity.botId, fingerprint: identity.fingerprint,
      actorId, messageId, conversationId, requestId: value.requestId, action: value.action, ...(roleId ? { roleId } : {}) });
  }
  if (event.action.tag !== 'button' || !['allowed-once', 'rejected'].includes(value.action)) refuse('invalid-inbound');
  return Object.freeze({ version: 1, channel: 'feishu', botId: identity.botId, fingerprint: identity.fingerprint,
    actorId, messageId, conversationId, requestId: value.requestId, action: value.action });
}

export async function replyExternalApprovalCard(client, route, card, { signal, assertCurrent, beforeSend } = {}) {
  const content = externalApprovalCard(card);
  assertCurrent?.();
  const current = await qualifyExternalReply(client, route, signal);
  if (current.actorId !== route.actorId) refuse('stale-route');
  const chat = await client.im.v1.chat.get({ path: { chat_id: route.conversationId } }, { signal });
  if (chat?.code !== 0 || !(card.kind === 'pairing' ? ['p2p', 'group'] : ['p2p']).includes(chat?.data?.chat_mode)) refuse('stale-route');
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
