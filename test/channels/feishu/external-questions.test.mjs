import assert from 'node:assert/strict';
import test from 'node:test';
import { externalQuestionCard } from '../../../src/channels/feishu/external-questions.mjs';
import { normalizeExternalCardAction, replyExternalApprovalCard, updateExternalApprovalCard } from '../../../src/channels/feishu/external-cards.mjs';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const identity = { botId: 'qa', appId: 'cli_qa', botOpenId: 'ou_bot', fingerprint: 'a'.repeat(64) };
const route = { messageId: 'om_source', conversationId: 'oc_private', actorId: 'ou_alice' };
const card = { requestId: id, reference: 'AAAAAAAAAAAA', detail: 'Choose and submit', status: 'pending',
  questions: [{ id: 'q', question: 'Choose [one](https://example.invalid)', options: [{ label: 'One' }, { label: 'Two' }] }, { id: 'text', question: 'Explain' }] };
const event = () => ({ app_id: 'cli_qa', operator: { open_id: 'ou_alice' },
  context: { open_message_id: 'om_card', open_chat_id: 'oc_private' },
  action: { tag: 'button', value: { namespace: 'botharness/question-v1', requestId: id, count: 2, actorId: 'ou_forged' },
    form_value: { q0_choices: '1', q0_custom: '', q1_custom: 'My answer' } } });

test('question forms submit all answers explicitly and never preselect or emit permission actions', () => {
  const result = JSON.parse(externalQuestionCard(card));
  assert.equal(result.schema, '2.0');
  const detailed = externalQuestionCard({...card, questions: [{id: 'q', header: 'Branch', question: 'Choose', detail: 'Use the current branch', options: [{label: 'Main', description: 'Current branch'}]}]});
  assert.equal(detailed.includes('Use the current branch'), true);
  assert.equal(detailed.includes('Main: Current branch'), true);
  const form = result.body.elements[1];
  assert.equal(form.tag, 'form');
  const dropdown = form.elements.find((element) => element.tag === 'select_static');
  assert.equal(dropdown.name, 'q0_choices');
  assert.deepEqual(dropdown.options.map((option) => option.value), ['0', '1']);
  assert.equal(dropdown.initial_option, undefined);
  const submit = form.elements.at(-1);
  assert.equal(submit.form_action_type, 'submit');
  assert.equal(submit.behaviors[0].value.namespace, 'botharness/question-v1');
  assert.equal(submit.behaviors[0].value.actorId, undefined);
  assert.equal(form.elements[0].content.includes('\\['), true);
  assert.equal(form.elements[0].content.includes('\\\\['), false);
  for (const status of ['answered', 'cancelled', 'expired', 'web-required'])
    assert.equal(JSON.parse(externalQuestionCard({ ...card, status })).body.elements.length, 1);
});

test('question answer evidence uses actual SDK actor and receipt with bounded explicit form values', () => {
  const evidence = normalizeExternalCardAction(event(), identity);
  assert.equal(evidence.actorId, 'ou_alice');
  assert.equal(evidence.messageId, 'om_card');
  assert.equal(evidence.action, 'answer');
  assert.deepEqual(evidence.values, [{ selected: [1] }, { selected: [], custom: 'My answer' }]);
  const multi = event(); multi.action.form_value.q0_choices = ['0', '1'];
  assert.deepEqual(normalizeExternalCardAction(multi, identity).values[0].selected, [0, 1]);
  for (const values of [{ q0_choices: ['0', '0'] }, { q0_choices: 'permission' }, { q0_custom: 'a'.repeat(2001) }, { injected: 'answer' }]) {
    const forged = event(); forged.action.form_value = values;
    assert.throws(() => normalizeExternalCardAction(forged, identity));
  }
  const wrongActor = event(); wrongActor.operator = { user_id: 'ou_alice' };
  assert.throws(() => normalizeExternalCardAction(wrongActor, identity), { code: 'invalid-inbound' });
  const wrongApp = event(); wrongApp.app_id = 'cli_other';
  assert.throws(() => normalizeExternalCardAction(wrongApp, identity), { code: 'account-changed' });
});

function fixture() {
  let creates = 0, patches = 0;
  const client = { im: { v1: { message: {
    get: async ({ path }) => ({ code: 0, data: { items: [{ message_id: path.message_id, chat_id: 'oc_private', msg_type: 'interactive',
      sender: path.message_id === 'om_source' ? { sender_type: 'user', id_type: 'open_id', id: 'ou_alice' } : { sender_type: 'app', id_type: 'app_id', id: 'cli_qa' } }] } }),
    create: async () => { creates++; return { code: 0, data: { message_id: 'om_card', chat_id: 'oc_private' } }; },
    patch: async () => { patches++; return { code: 0 }; },
  }, chat: { get: async () => ({ code: 0, data: { chat_mode: 'p2p' } }) } } } };
  return { client, counts: () => ({ creates, patches }) };
}

test('checked question writes retain private native destination, own receipt and final authority fences', async () => {
  const f = fixture();
  const options = { render: externalQuestionCard, privateOnly: true, beforeSend: () => true };
  const result = await replyExternalApprovalCard(f.client, route, card, options);
  assert.equal(result.receipt.messageId, 'om_card');
  await updateExternalApprovalCard(f.client, identity, result.receipt, { ...card, status: 'answered' }, options);
  assert.deepEqual(f.counts(), { creates: 1, patches: 1 });
  await assert.rejects(replyExternalApprovalCard(f.client, route, card, { ...options, beforeSend: () => false }), { code: 'stale-route' });
  f.client.im.v1.chat.get = async () => ({ code: 0, data: { chat_mode: 'group' } });
  await assert.rejects(updateExternalApprovalCard(f.client, identity, result.receipt, card, options), { code: 'stale-route' });
  assert.deepEqual(f.counts(), { creates: 1, patches: 1 });
});
