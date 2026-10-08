import assert from 'node:assert/strict';
import test from 'node:test';
import { reactExternalMessage } from '../../../src/channels/feishu/external-reactions.mjs';

function fixture() {
  const source = { message_id: 'om_source', chat_id: 'oc_team', thread_id: 'omt_topic',
    sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_human' } };
  const route = { messageId: 'om_source', conversationId: 'oc_team', actorId: 'ou_human', threadId: 'omt_topic' };
  const writes = [];
  const client = { im: { v1: {
    message: { get: async () => ({ code: 0, data: { items: [source] } }) },
    messageReaction: { create: async input => { writes.push(input); return { code: 0, data: {
      reaction_id: 'reaction', operator: { operator_type: 'app', operator_id: 'cli_qa' },
      reaction_type: input.data.reaction_type } }; } },
  } } };
  const context = { assertCurrent() {}, beforeSend: () => true, signal: new AbortController().signal };
  return { source, route, writes, client, context,
    react: (kind, options = context) => reactExternalMessage(client, { appId: 'cli_qa' }, route, kind, options) };
}
test('writes two native emoji types only against the checked original source', async () => {
  const fx = fixture();
  for (const kind of ['received', 'answered']) assert.deepEqual(await fx.react(kind), { accepted: true });
  assert.deepEqual(fx.writes.map(value => [value.path.message_id, value.data.reaction_type.emoji_type]),
    [['om_source', 'GLANCE'], ['om_source', 'DONE']]);
});
for (const field of ['chat_id', 'thread_id']) test(`refuses mismatched ${field} before writing`, async () => {
  const fx = fixture(); fx.source[field] = 'other';
  await assert.rejects(fx.react('received'), { code: 'stale-route' }); assert.equal(fx.writes.length, 0);
});
test('refuses changed sender, deleted source, caller fence and cancellation', async () => {
  const fx = fixture(); fx.source.sender.id = 'ou_other';
  await assert.rejects(fx.react('received'), { code: 'stale-route' });
  fx.source.sender.id = 'ou_human'; fx.source.deleted = true;
  await assert.rejects(fx.react('received'), { code: 'source-not-found' }); delete fx.source.deleted;
  await assert.rejects(fx.react('received', { ...fx.context, beforeSend: () => false }), { code: 'stale-route' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(fx.react('received', { ...fx.context, signal: abort.signal }));
  assert.equal(fx.writes.length, 0);
});
test('validates actual write permission, result identity and unknown transport without retry', async () => {
  const fx = fixture(); let writes = 0;
  for (const [response, code] of [[{ code: 99991672 }, 'reaction-permission-denied'],
    [{ code: 231002 }, 'reaction-permission-denied'], [{ code: 231015 }, 'reaction-result-unknown'],
    [{ code: 0, data: { reaction_id: 'other', operator: { operator_type: 'app', operator_id: 'cli_other' } } }, 'reaction-result-unknown'],
    [undefined, 'reaction-result-unknown']]) {
    fx.client.im.v1.messageReaction.create = async () => { writes++; return response; };
    await assert.rejects(fx.react('answered'), { code });
  }
  assert.equal(writes, 5);
  fx.client.im.v1.messageReaction.create = async () => { writes++; throw new Error('timeout'); };
  await assert.rejects(fx.react('answered'), /timeout/); assert.equal(writes, 6);
});
