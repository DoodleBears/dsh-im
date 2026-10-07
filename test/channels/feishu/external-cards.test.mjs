import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeExternalCardAction, externalApprovalCard, normalizeExternalCardAction, replyExternalApprovalCard, updateExternalApprovalCard } from '../../../src/channels/feishu/external-cards.mjs';
import { ExclusiveInboundConsumers } from '../../../src/channels/shared/exclusive-inbound-consumers.mjs';

const requestId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const identity = { botId: 'qa', appId: 'cli_qa', botOpenId: 'ou_bot', fingerprint: 'a'.repeat(64) };
const route = { messageId: 'om_source', conversationId: 'oc_private', actorId: 'ou_alice' };
const card = { requestId, title: 'QA approval', detail: 'bash: pwd', status: 'pending' };
const event = () => ({ operator: { open_id: 'ou_alice' }, context: { open_message_id: 'om_card', open_chat_id: 'oc_private' }, action: { tag: 'button', value: { namespace: 'botharness/approval-v1', requestId, action: 'allowed-once' } } });

test('only strict native operator and context fields become actionable evidence', () => {
  assert.equal(normalizeExternalCardAction(event(), identity).actorId, 'ou_alice');
  assert.equal(normalizeExternalCardAction({ ...event(), action: { value: {} } }, identity), null);
  assert.throws(() => normalizeExternalCardAction({ ...event(), operator: { user_id: 'ou_alice' } }, identity), { code: 'invalid-inbound' });
  assert.throws(() => normalizeExternalCardAction({ ...event(), app_id: 'other' }, identity), { code: 'account-changed' });
  for (const key of ['open_message_id', 'open_chat_id']) {
    const forged = event(); delete forged.context[key]; forged[key] = 'forged';
    assert.throws(() => normalizeExternalCardAction(forged, identity), { code: 'invalid-inbound' });
  }
  const forged = event(); forged.action.value.action = 'allowed-always-all';
  assert.throws(() => normalizeExternalCardAction(forged, identity), { code: 'invalid-inbound' });
});

test('cards render bounded plain text and only once/reject controls', () => {
  const rendered = JSON.parse(externalApprovalCard(card));
  assert.equal(rendered.elements[0].text.tag, 'plain_text');
  assert.equal(rendered.elements[1].actions.length, 2);
  assert.equal(JSON.parse(externalApprovalCard({ ...card, status: 'executed' })).elements.length, 1);
  assert.throws(() => externalApprovalCard({ ...card, detail: 'a'.repeat(16001) }), { code: 'bad-request' });
});

function clientFixture() {
  let creates = 0, patches = 0;
  const client = { im: { v1: { message: {
    get: async ({ path }) => ({ code: 0, data: { items: [{ message_id: path.message_id, chat_id: 'oc_private', msg_type: 'interactive',
      sender: path.message_id === 'om_source' ? { sender_type: 'user', id_type: 'open_id', id: 'ou_alice' }
        : { sender_type: 'app', id_type: 'app_id', id: 'cli_qa' } }] } }),
    create: async () => { creates++; return { code: 0, data: { message_id: 'om_card', chat_id: 'oc_private' } }; },
    patch: async () => { patches++; return { code: 0 }; },
  }, chat: { get: async () => ({ code: 0, data: { chat_mode: 'p2p' } }) } } } };
  return { client, counts: () => ({ creates, patches }) };
}

test('send verifies original sender/private conversation and fences immediately before writing', async () => {
  const f = clientFixture();
  await assert.rejects(replyExternalApprovalCard(f.client, { ...route, actorId: 'ou_other' }, card, { beforeSend: () => true }), { code: 'stale-route' });
  await assert.rejects(replyExternalApprovalCard(f.client, route, card, { beforeSend: () => false }), { code: 'stale-route' });
  assert.equal(f.counts().creates, 0);
  const sent = await replyExternalApprovalCard(f.client, route, card, { beforeSend: () => true });
  assert.equal(sent.receipt.messageId, 'om_card');
  f.client.im.v1.chat.get = async () => ({ code: 0, data: { chat_mode: 'group' } });
  await assert.rejects(replyExternalApprovalCard(f.client, route, card, { beforeSend: () => true }), { code: 'stale-route' });
  assert.equal(f.counts().creates, 1);
});

test('update checks Bot authorship, exact conversation and final authority fence', async () => {
  const f = clientFixture(), receipt = { messageId: 'om_card', conversationId: 'oc_private' };
  await assert.rejects(updateExternalApprovalCard(f.client, { ...identity, appId: 'cli_other' }, receipt, card, { beforeSend: () => true }), { code: 'stale-route' });
  await assert.rejects(updateExternalApprovalCard(f.client, identity, { ...receipt, conversationId: 'oc_other' }, card, { beforeSend: () => true }), { code: 'stale-route' });
  await assert.rejects(updateExternalApprovalCard(f.client, identity, receipt, card, { beforeSend: () => false }), { code: 'stale-route' });
  assert.equal(f.counts().patches, 0);
  await updateExternalApprovalCard(f.client, identity, receipt, card, { beforeSend: () => true });
  assert.equal(f.counts().patches, 1);
});

test('callback is separate from text intake and cannot survive registration disposal', async () => {
  const consumers = new ExclusiveInboundConsumers();
  const dispose = consumers.register('qa', { fingerprint: identity.fingerprint,
    onEvent: () => { throw new Error('action must not enter text intake'); }, onAction: async () => ({ accepted: true, status: 'refused' }) });
  const ack = await consumers.acceptAction('qa', normalizeExternalCardAction(event(), identity));
  assert.equal(ack.toast.type, 'error');
  dispose();
  await assert.rejects(consumers.acceptAction('qa', normalizeExternalCardAction(event(), identity)), { code: 'consumer-unavailable' });
});


test('malformed SDK acknowledgements are ambiguous instead of known unsent', async () => {
  const f=clientFixture();
  f.client.im.v1.message.create=async () => undefined;
  await assert.rejects(replyExternalApprovalCard(f.client,route,card,{beforeSend:()=>true}),{code:'send-result-unknown'});
  f.client.im.v1.message.patch=async () => ({});
  await assert.rejects(updateExternalApprovalCard(f.client,identity,{messageId:'om_card',conversationId:'oc_private'},card,{beforeSend:()=>true}),{code:'send-result-unknown'});
});


test('callback deadline refuses stalled handlers and aborts any late authorization', async () => {
  let lifetime;
  const keepAlive=setTimeout(()=>{},1000);
  try {
    const result=await consumeExternalCardAction((_event,{signal})=>{lifetime=signal;return new Promise(()=>{});},event(),new AbortController().signal,5);
    assert.equal(result.toast.type,'error');assert.equal(lifetime.aborted,true);
  } finally {clearTimeout(keepAlive);}
});

test('fast acknowledgements preserve the consumer lifetime instead of expiring an accepted decision', async () => {
  let lifetime;
  const source=new AbortController();
  const result=await consumeExternalCardAction((_event,{signal})=>{lifetime=signal;return {toast:{type:'info',content:'queued'}};},event(),source.signal,5);
  assert.equal(result.toast.type,'info');assert.equal(lifetime.aborted,false);
  source.abort();assert.equal(lifetime.aborted,true);
});
