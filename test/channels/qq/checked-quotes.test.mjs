import assert from 'node:assert/strict';
import test from 'node:test';

import { QqExternalConsumer, verifiedQqAccount } from '../../../src/channels/qq/external-consumer.mjs';

const account = verifiedQqAccount('12345678', { id: 'native-bot-id', username: 'QA Bot', bot: true });

function consumer({ sourceFiles = false, sourceImages = false, ordinaryText = false } = {}) {
  const accepted = [];
  return {
    accepted,
    consumer: new QqExternalConsumer({ bot: {}, account, botId: 'qq-bot', nativeUser: { id: 'native-bot-id' },
      sourceFiles: () => sourceFiles, sourceImages: () => sourceImages, ordinaryText: () => ordinaryText,
      accept: async (event) => { accepted.push(event); return { accepted: true }; } }),
  };
}

// A member quotes someone else's text message and @s the Bot in the same message.
function quotedTextMention({ content = 'what does this mean?', quoted = 'the original text', attachments } = {}) {
  const elements = [{ msg_idx: 'quoted-text-index', content: quoted, message_type: 0, ...(attachments ? { attachments } : {}) }];
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

const imageUrl = 'https://multimedia.nt.qq.com.cn/download?private-ticket=image';
const image = { content_type: 'image/png', url: imageUrl, filename: 'chart.png', size: 64 };

function directMention(overrides = {}) {
  return { kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: 'native-source-id',
    senderId: 'app-scoped-member', groupOpenid: 'app-scoped-group', content: 'look at this',
    timestamp: new Date().toISOString(),
    replyTarget: { scope: 'group', targetId: 'app-scoped-group', msgId: 'native-source-id' }, ...overrides };
}

test('quote + mention of an image attaches the quoted image under the quote reference', async () => {
  const fx = consumer({ sourceImages: true });
  await fx.consumer.accept(quotedTextMention({ quoted: '', attachments: [image] }), new AbortController().signal);
  const [event] = fx.accepted;
  assert.equal(event.text, 'what does this mean?\n\n[Quoted message]\n[Quoted image]');
  assert.equal(event.attachments.length, 1);
  assert.equal(event.attachments[0].mediaType, 'image/png');
  assert.deepEqual(event.contentParts, [{ kind: 'text', text: event.text }, { kind: 'attachment', id: event.attachments[0].id }]);
});

test('a quoted message with both text and an image keeps both', async () => {
  const fx = consumer({ sourceImages: true, sourceFiles: true });
  await fx.consumer.accept(quotedTextMention({ content: '', quoted: 'sales by month', attachments: [image] }),
    new AbortController().signal);
  const [event] = fx.accepted;
  assert.equal(event.text, '[Quoted message]\nsales by month\n[Quoted image]');
  assert.equal(event.attachments.length, 1);
});

test('quoted media the consumer cannot read is named in the text instead of dropping the message', async () => {
  const fx = consumer();
  await fx.consumer.accept(quotedTextMention({ quoted: 'see below', attachments: [image, { content_type: 'voice', url: imageUrl }] }),
    new AbortController().signal);
  const [event] = fx.accepted;
  assert.equal(event.text, 'what does this mean?\n\n[Quoted message]\nsee below\n'
    + '[Quoted image not readable by the Bot]\n[Quoted voice message not readable by the Bot]');
  assert.equal(event.attachments, undefined);
});

test('a mixed message keeps its text and readable images and names the rest', async () => {
  const fx = consumer({ sourceImages: true });
  await fx.consumer.accept(directMention({ attachments: [image, { content_type: 'video/mp4', url: imageUrl }] }),
    new AbortController().signal);
  const [event] = fx.accepted;
  assert.equal(event.text, 'look at this\n[Video not readable by the Bot]');
  assert.equal(event.attachments.length, 1);
  assert.deepEqual(event.contentParts.map(part => part.kind), ['text', 'attachment']);
});

test('QQ image aliases, file-name types and scheme-less URLs are still read as images', async t => {
  const fx = consumer({ sourceImages: true });
  await fx.consumer.accept(directMention({ attachments: [
    { content_type: 'image/jpg', url: '//multimedia.nt.qq.com.cn/a' },
    { content_type: 'image', filename: 'photo.WEBP', url: 'http://gchat.qpic.cn/b' },
  ] }), new AbortController().signal);
  const [event] = fx.accepted;
  assert.deepEqual(event.attachments.map(file => file.mediaType), ['image/jpeg', 'image/webp']);
  const requested = [];
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  t.mock.method(globalThis, 'fetch', async url => { requested.push(String(url)); return new Response(png); });
  const stream = await fx.consumer.readImage(event.reply, event.attachments[0], { verifyAccount: async () => {} });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), png);
  assert.deepEqual(requested, ['https://multimedia.nt.qq.com.cn/a']);
});

test('an @ with no text still reaches the Bot', async () => {
  const fx = consumer();
  await fx.consumer.accept(directMention({ content: '  ' }), new AbortController().signal);
  assert.equal(fx.accepted[0].text, '[Mentioned the Bot with no text]');
  assert.equal(fx.accepted[0].mentionedAccount, true);
});

test('an ordinary quote is admitted as text when ordinary messages are on', async () => {
  const fx = consumer({ ordinaryText: true, sourceImages: true });
  const message = { ...quotedTextMention({ attachments: [image] }), rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [] };
  await fx.consumer.accept(message, new AbortController().signal);
  const [event] = fx.accepted;
  assert.equal(event.mentionedAccount, false);
  assert.equal(event.text, 'what does this mean?\n\n[Quoted message]\nthe original text\n[Quoted image not readable by the Bot]');
  assert.equal(event.attachments, undefined);
});

test('a quote whose normalized and raw attachments disagree is refused', async () => {
  const fx = consumer({ sourceImages: true });
  const message = quotedTextMention({ attachments: [image] });
  await assert.rejects(() => fx.consumer.accept({ ...message, msgElements: [{ msg_idx: 'quoted-text-index' }] },
    new AbortController().signal), { code: 'invalid-inbound', reason: 'quote-elements-invalid' });
});
