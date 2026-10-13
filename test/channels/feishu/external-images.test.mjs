import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { normalizeExternalMedia } from '../../../src/channels/feishu/external-consumer.mjs';
import { readExternalFile } from '../../../src/channels/feishu/external-files.mjs';

const identity = { botId: 'bot', appId: 'app', botOpenId: 'bot-open', fingerprint: 'a'.repeat(64) };
const payload = (type, content) => ({ event_id: 'event', app_id: 'app', sender: { sender_type: 'user', sender_id: { open_id: 'human' } }, message: { message_id: 'message', chat_id: 'chat', chat_type: 'p2p', message_type: type, content: JSON.stringify(content), create_time: '1791290000000' } });

test('native image and ordered rich-text images retain exact resources, text and one native message', () => {
  const image = normalizeExternalMedia(payload('image', { image_key: 'image-one' }), identity);
  assert.equal(image.messageId, 'message');
  assert.equal(image.attachments[0].messageId, 'message');
  assert.equal(image.attachments[0].resourceKey, 'image-one');
  assert.equal(image.text, '[Image]');
  const mixed = normalizeExternalMedia(payload('post', { en_us: { title: '', content: [[{ tag: 'text', text: 'before ' }, { tag: 'img', image_key: 'one' }, { tag: 'text', text: ' between ' }, { tag: 'img', image_key: 'two' }, { tag: 'text', text: ' after' }]] } }), identity);
  assert.deepEqual(mixed.contentParts.map(x => x.kind), ['text', 'attachment', 'text', 'attachment', 'text']);
  assert.equal(mixed.text, 'before  between  after');
  assert.equal(mixed.attachments.length, 2);
  assert.equal(new Set(mixed.attachments.map(x => x.id)).size, 2);
  assert.equal(normalizeExternalMedia({ ...payload('image', { image_key: 'one' }), sender: { sender_type: 'app' } }, identity), null);
  assert.throws(() => normalizeExternalMedia(payload('image', { image_key: '' }), identity), { code: 'invalid-inbound' });
});

test('checked image download binds key to current original message and refuses changed resources before fetch', async () => {
  const event = normalizeExternalMedia(payload('image', { image_key: 'one' }), identity);
  let calls = 0;
  let key = 'one';
  const client = { im: { v1: {
    message: { get: async () => ({ data: { items: [{ message_id: 'message', chat_id: 'chat', msg_type: 'image', sender: { sender_type: 'user', id_type: 'open_id', id: 'human' }, body: { content: JSON.stringify({ image_key: key }) } }] } }) },
    messageResource: { get: async input => { calls++; assert.deepEqual(input, { path: { message_id: 'message', file_key: 'one' }, params: { type: 'image' } }); return { getReadableStream: () => Readable.from([Buffer.from('image bytes')]) }; } },
  } } };
  const context = { signal: new AbortController().signal, assertCurrent() {} };
  const stream = await readExternalFile(client, event.reply, event.attachments[0], context);
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'image bytes');
  key = 'replacement';
  await assert.rejects(readExternalFile(client, event.reply, event.attachments[0], context), { code: 'stale-route' });
  assert.equal(calls, 1);
});


test('a repeated native image stays at both ordered positions without duplicating its descriptor', () => {
  const mixed = normalizeExternalMedia(payload('post', { content: [[{tag:'img', image_key:'one'}, {tag:'text', text:'again'}, {tag:'img', image_key:'one'}]] }), identity);
  assert.equal(mixed.attachments.length, 1);
  assert.deepEqual(mixed.contentParts.map(item => item.kind), ['attachment','text','attachment']);
  assert.equal(mixed.contentParts[0].id, mixed.contentParts[2].id);
});

test('native posts retain verified group mentions and reject unsupported mixed elements without partial intake', () => {
  const source = payload('post', { content: [[{tag:'at', user_id:'bot-open', user_name:'QA'}, {tag:'img', image_key:'one'}]] });
  source.message.chat_type = 'group'; source.message.mentions = [{ id: { open_id: 'bot-open' }, key:'@_user_1', name:'QA' }];
  assert.equal(normalizeExternalMedia(source, identity).mentionedAccount, true);
  assert.throws(() => normalizeExternalMedia(payload('post', { content: [[{tag:'img',image_key:'one'}, {tag:'media',file_key:'unsupported'}]] }), identity), { code:'invalid-inbound' });
});
