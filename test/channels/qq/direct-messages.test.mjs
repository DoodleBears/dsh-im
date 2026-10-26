import assert from 'node:assert/strict';
import test from 'node:test';

import { QqExternalConsumer, verifiedQqAccount } from '../../../src/channels/qq/external-consumer.mjs';

const account = verifiedQqAccount('12345678', { id: 'native-bot-id', username: 'QA Bot', bot: true });
const imageUrl = 'https://multimedia.nt.qq.com.cn/download?private-ticket=image';

function consumer({ sourceImages = false, directMessages = true } = {}) {
  const accepted = [];
  const sent = [];
  const bot = {
    api: { getToken: async () => 'test-token' },
    apiClient: { request: async (_token, method, path, body) => { sent.push({ method, path, body }); return { id: `reply-${sent.length}` }; } },
  };
  return {
    accepted, sent,
    consumer: new QqExternalConsumer({ bot, account, botId: 'qq-bot', nativeUser: { id: 'native-bot-id' },
      sourceImages: () => sourceImages, directMessages: () => directMessages,
      accept: async event => { accepted.push(event); return { accepted: true }; } }),
  };
}

function direct({ messageId = 'c2c-source', at = new Date(), ...overrides } = {}) {
  return { kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', messageId, senderId: 'app-scoped-user',
    content: 'hello in private', timestamp: at.toISOString(),
    replyTarget: { scope: 'c2c', targetId: 'app-scoped-user', msgId: messageId }, ...overrides };
}

test('a private QQ message is admitted as a direct conversation with the sender as its id', async () => {
  const fx = consumer();
  await fx.consumer.accept(direct(), new AbortController().signal);
  const [event] = fx.accepted;
  assert.deepEqual(event.conversation, { kind: 'dm', id: 'app-scoped-user' });
  assert.equal(event.mentionedAccount, false);
  assert.deepEqual(event.mentions, []);
  assert.equal(event.text, 'hello in private');
  assert.deepEqual(event.reply, { messageId: 'c2c-source', conversationId: 'app-scoped-user', actorId: 'app-scoped-user' });
});

test('a private reply is a passive C2C reply to the source message', async () => {
  const fx = consumer();
  await fx.consumer.accept(direct(), new AbortController().signal);
  const result = await fx.consumer.reply(fx.accepted[0].reply, 'private answer', { signal: new AbortController().signal });
  assert.equal(result.sent, true);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0].path, '/v2/users/app-scoped-user/messages');
  assert.equal(fx.sent[0].body.msg_id, 'c2c-source');
  assert.equal(fx.sent[0].body.content, 'private answer');
});

test('the C2C passive window is 60 minutes and four replies', async () => {
  const fx = consumer();
  await fx.consumer.accept(direct({ at: new Date(Date.now() - 30 * 60_000) }), new AbortController().signal);
  const route = fx.accepted[0].reply;
  for (let index = 0; index < 4; index++)
    await fx.consumer.reply(route, `answer ${index}`, { signal: new AbortController().signal });
  await assert.rejects(() => fx.consumer.reply(route, 'one too many', { signal: new AbortController().signal }),
    { code: 'reply-limit-exceeded' });
  await fx.consumer.accept(direct({ messageId: 'old-c2c', at: new Date(Date.now() - 61 * 60_000) }), new AbortController().signal);
  await assert.rejects(() => fx.consumer.reply(fx.accepted[1].reply, 'late', { signal: new AbortController().signal }),
    { code: 'reply-window-expired' });
});

test('a private image is attached and a private quote is verified against the C2C author', async () => {
  const fx = consumer({ sourceImages: true });
  await fx.consumer.accept(direct({ content: '', attachments: [{ content_type: 'image/png', url: imageUrl, size: 64 }] }),
    new AbortController().signal);
  assert.equal(fx.accepted[0].text, '[Image]');
  assert.equal(fx.accepted[0].attachments[0].mediaType, 'image/png');
  const elements = [{ msg_idx: 'quoted-index', content: 'earlier private text', message_type: 0 }];
  const quote = direct({ messageId: 'c2c-quote', content: 'what about this?', msgType: 103, refMsgIdx: 'quoted-index',
    msgElements: elements, raw: { id: 'c2c-quote', message_type: 103, author: { user_openid: 'app-scoped-user' },
      msg_elements: elements, message_scene: { ext: ['ref_msg_idx=quoted-index'] } } });
  await fx.consumer.accept(quote, new AbortController().signal);
  assert.equal(fx.accepted[1].text, 'what about this?\n\n[Quoted message]\nearlier private text');
  await assert.rejects(() => fx.consumer.accept({ ...quote, messageId: 'c2c-forged',
    replyTarget: { scope: 'c2c', targetId: 'app-scoped-user', msgId: 'c2c-forged' },
    raw: { ...quote.raw, id: 'c2c-forged', author: { user_openid: 'someone-else' } } }, new AbortController().signal),
  { code: 'invalid-inbound', reason: 'quote-envelope-invalid' });
});

test('private messages are not admitted unless the consumer opts in', async () => {
  const fx = consumer({ directMessages: false });
  await fx.consumer.accept(direct(), new AbortController().signal);
  assert.equal(fx.accepted.length, 0);
});

test('a private message with a mismatched reply target is refused', async () => {
  const fx = consumer();
  await assert.rejects(() => fx.consumer.accept(direct({ replyTarget: { scope: 'group', targetId: 'app-scoped-user', msgId: 'c2c-source' } }),
    new AbortController().signal), { code: 'invalid-inbound' });
  assert.equal(fx.accepted.length, 0);
});
