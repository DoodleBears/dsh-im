import assert from 'node:assert/strict';
import test from 'node:test';

import { QqExternalConsumer, verifiedQqAccount } from '../../../src/channels/qq/external-consumer.mjs';

const account = verifiedQqAccount('12345678', { id: 'native-bot-id', username: 'QA Bot', bot: true });

function consumer({ sourceFiles = false } = {}) {
  const accepted = [];
  return {
    accepted,
    consumer: new QqExternalConsumer({ bot: {}, account, botId: 'qq-bot', nativeUser: { id: 'native-bot-id' },
      sourceFiles: () => sourceFiles,
      accept: async (event) => { accepted.push(event); return { accepted: true }; } }),
  };
}

// A member quotes someone else's text message and @s the Bot in the same message.
function quotedTextMention({ content = 'what does this mean?', quoted = 'the original text' } = {}) {
  const elements = [{ msg_idx: 'quoted-text-index', content: quoted, message_type: 0 }];
  return {
    kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: 'native-source-id',
    senderId: 'app-scoped-member', groupOpenid: 'app-scoped-group', content,
    timestamp: new Date().toISOString(), msgType: 103, refMsgIdx: 'quoted-text-index',
    msgElements: elements, attachments: undefined,
    replyTarget: { scope: 'group', targetId: 'app-scoped-group', msgId: 'native-source-id' },
    raw: { id: 'native-source-id', group_openid: 'app-scoped-group', message_type: 103,
      author: { member_openid: 'app-scoped-member' }, msg_elements: elements,
      message_scene: { ext: ['ref_msg_idx=quoted-text-index'] } },
  };
}

for (const sourceFiles of [false, true]) {
  test(`quote + mention of a text message is admitted with the quoted text (files ${sourceFiles ? 'on' : 'off'})`, async () => {
    const fx = consumer({ sourceFiles });
    await fx.consumer.accept(quotedTextMention(), new AbortController().signal);
    assert.equal(fx.accepted.length, 1);
    const [event] = fx.accepted;
    assert.equal(event.mentionedAccount, true);
    assert.equal(event.text, 'what does this mean?\n\n[Quoted message]\nthe original text');
    assert.deepEqual(event.reply, { messageId: 'native-source-id', conversationId: 'app-scoped-group',
      actorId: 'app-scoped-member' });
  });
}

test('quote + bare mention is still admitted when the caption is empty', async () => {
  const fx = consumer();
  await fx.consumer.accept(quotedTextMention({ content: ' ' }), new AbortController().signal);
  assert.equal(fx.accepted[0].text, '[Quoted message]\nthe original text');
});

test('a quote whose text QQ did not carry is admitted with a placeholder', async () => {
  const fx = consumer();
  await fx.consumer.accept(quotedTextMention({ quoted: '' }), new AbortController().signal);
  assert.equal(fx.accepted[0].text, 'what does this mean?\n\n[Quoted message]');
});

test('an ordinary quote without a mention stays unaddressed', async () => {
  const fx = consumer();
  const message = { ...quotedTextMention(), rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [] };
  await fx.consumer.accept(message, new AbortController().signal);
  assert.equal(fx.accepted.length, 0);
});

test('a mismatched quote reference is refused visibly instead of vanishing', async () => {
  const fx = consumer();
  const message = { ...quotedTextMention(), refMsgIdx: 'another-index' };
  await assert.rejects(() => fx.consumer.accept(message, new AbortController().signal),
    { code: 'invalid-inbound', reason: 'quote-reference-invalid' });
  assert.equal(fx.accepted.length, 0);
});
