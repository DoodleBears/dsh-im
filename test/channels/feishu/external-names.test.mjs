import assert from 'node:assert/strict';
import test from 'node:test';
import { externalSenderName } from '../../../src/channels/feishu/external-names.mjs';

const evidence = Object.freeze({ version: 1, channel: 'feishu', botId: 'bot', fingerprint: 'a'.repeat(64),
  eventId: 'event', messageId: 'message', actor: Object.freeze({ kind: 'user', id: 'actor' }),
  conversation: { kind: 'group', id: 'chat' }, text: '@_user_1 original',
  mentions: [{ id: 'bot-open-id', key: '@_user_1', name: 'QA Bot' }], mentionedAccount: true,
  reply: { messageId: 'message', conversationId: 'chat', actorId: 'actor', threadId: 'thread', rootId: 'root', parentId: 'parent' } });
const source = () => ({ message_id: 'message', chat_id: 'chat', msg_type: 'text',
  thread_id: 'thread', root_id: 'root', parent_id: 'parent',
  sender: { sender_type: 'user', id_type: 'open_id', id: 'actor', sender_name: ' Doodle <QA> ' },
  body: { content: JSON.stringify({ text: evidence.text }) } });
const client = get => ({ im: { v1: { message: { get } } } });

test('checked native source adds only a sender name without changing causal evidence', async () => {
  const before = JSON.stringify(evidence);
  const result = await externalSenderName(client(async (request, options) => {
    assert.deepEqual(request, { path: { message_id: 'message' }, params: { with_sender_name: true } });
    assert.equal(options.signal.aborted, false);
    return { code: 0, data: { items: [source()] } };
  }), evidence);
  assert.equal(result.actor.name, 'Doodle <QA>');
  assert.deepEqual({ ...result, actor: evidence.actor }, evidence);
  assert.equal(JSON.stringify(evidence), before);
  assert.equal(Object.isFrozen(result.actor), true);
});

for (const field of ['message_id', 'chat_id', 'thread_id', 'root_id', 'parent_id', 'msg_type']) {
  test(`a foreign native ${field} never supplies a name`, async () => {
    const wrong = { ...source(), [field]: 'foreign' };
    assert.equal(await externalSenderName(client(async () => ({ data: { items: [wrong] } })), evidence), evidence);
  });
}
for (const field of ['id', 'id_type', 'sender_type']) {
  test(`a mismatched native sender ${field} keeps original evidence`, async () => {
    const wrong = source(); wrong.sender[field] = 'foreign';
    assert.equal(await externalSenderName(client(async () => ({ data: { items: [wrong] } })), evidence), evidence);
  });
}
for (const kind of ['missing', 'blank', 'oversized', 'deleted', 'permission', 'throw', 'edited']) {
  test(`optional name ${kind} cannot prevent ordinary intake`, async () => {
    const item = source();
    if (kind === 'missing') delete item.sender.sender_name;
    if (kind === 'blank') item.sender.sender_name = '   ';
    if (kind === 'oversized') item.sender.sender_name = 'x'.repeat(513);
    if (kind === 'deleted') item.deleted = true;
    if (kind === 'edited') item.body.content = '{"text":"changed"}';
    const api = client(async () => {
      if (kind === 'throw') throw new Error('private native payload');
      return { code: kind === 'permission' ? 99991672 : 0, data: { items: [item] } };
    });
    assert.equal(await externalSenderName(api, evidence), evidence);
  });
}

test('deadline bounds a transport that ignores cancellation, and late data is inert', async () => {
  let finish;
  const api = client(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(await externalSenderName(api, evidence, { timeoutMs: 15 }), evidence);
  finish({ data: { items: [source()] } });
  await Promise.resolve();
  assert.equal(evidence.actor.name, undefined);
});

test('caller cancellation refuses even when the native lookup throws or ignores its signal', async () => {
  const controller = new AbortController();
  const pending = externalSenderName(client(async () => {
    controller.abort(new Error('canceled')); return { data: { items: [source()] } };
  }), evidence, { signal: controller.signal });
  await assert.rejects(pending, /canceled/);
  const stopped = new AbortController(); stopped.abort(new Error('stopped'));
  await assert.rejects(externalSenderName(client(() => { throw new Error('must not query'); }), evidence,
    { signal: stopped.signal }), /stopped/);
});

test('existing checked sender names need no further lookup', async () => {
  const named = { ...evidence, actor: { ...evidence.actor, name: 'Already known' } };
  assert.equal(await externalSenderName(client(() => { throw new Error('must not query'); }), named), named);
});
