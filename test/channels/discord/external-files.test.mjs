import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';
import { externalAttachments, readExternalFile, replyExternalFile } from '../../../src/channels/discord/external-files.mjs';
import { verifiedDiscordAccount } from '../../../src/channels/discord/external-consumer.mjs';

const id = { bot: '111111111111111111', app: '222222222222222222', guild: '333333333333333333',
  channel: '444444444444444444', thread: '555555555555555555', human: '666666666666666666',
  message: '777777777777777777', attachment: '888888888888888888', sent: '999999999999999999' };
const token = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(30)}`;
const account = verifiedDiscordAccount({ id: id.bot, bot: true }, { id: id.app, bot: { id: id.bot } });
const bytes = Buffer.from('synthetic QA file\n');
const permissions = (1n << 10n) | (1n << 11n) | (1n << 15n) | (1n << 16n) | (1n << 38n);
function fixture(thread = true) {
  const route = { conversationId: id.channel, messageId: id.message, actorId: id.human,
    ...(thread ? { threadId: id.thread } : {}) };
  const channelId = thread ? id.thread : id.channel;
  const parent = { id: id.channel, guild_id: id.guild, type: 0, permission_overwrites: [] };
  const child = { id: id.thread, parent_id: id.channel, guild_id: id.guild, type: 11,
    thread_metadata: { archived: false, locked: false } };
  const guild = { id: id.guild, roles: [{ id: id.guild, permissions: String(permissions) }] };
  const member = { user: { id: id.bot }, roles: [] };
  const source = { id: id.message, channel_id: channelId, author: { id: id.human }, type: 0,
    mentions: [{ id: id.bot }], attachments: [{ id: id.attachment, filename: 'input.txt', size: bytes.length,
      content_type: 'text/plain', url: `https://cdn.discordapp.com/attachments/${channelId}/${id.attachment}/input.txt?ex=old&hm=private` }] };
  const evidence = { reply: route, text: 'QA', fingerprint: account.fingerprint };
  const attachment = externalAttachments(evidence, source).attachments[0];
  const sends = []; const downloads = [];
  const result = { id: id.sent, channel_id: channelId, author: { id: id.bot, bot: true },
    message_reference: { message_id: id.message, channel_id: channelId },
    attachments: [{ id: id.sent, filename: 'result.txt', size: bytes.length }] };
  const api = { getChannel: async ({ channelId }) => channelId === id.thread ? child : parent,
    getGuild: async () => guild, getGuildMember: async () => member, getMessage: async () => source,
    downloadFileStream: async input => { downloads.push(input); return { length: String(bytes.length),
      stream: (async function* () { yield bytes; })() }; },
    createFileMessage: async input => { sends.push(input); return result; } };
  const options = { assertCurrent() {}, beforeSend: () => true };
  const file = { id: 'result-id', name: 'result.txt', bytes };
  return { route, source, evidence, attachment, api, options, parent, child, guild, member, sends, downloads, result, file };
}
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

test('single hosted metadata persists exact native identity, never signed URLs; unsupported files refuse', () => {
  const f = fixture();
  assert.equal(f.attachment.id.length, 64); assert.equal(f.attachment.messageId, id.message);
  assert.equal(f.attachment.resourceKey, id.attachment); assert.equal(f.attachment.sizeBytes, bytes.length);
  assert.equal(JSON.stringify(externalAttachments(f.evidence, f.source)).includes('private'), false);
  for (const change of [ { ephemeral: true }, { filename: '../input' }, { size: 0 }, { size: 1.5 }, { id: 12345 } ]) {
    const bad = { ...f.source, attachments: [{ ...f.source.attachments[0], ...change }] };
    assert.throws(() => externalAttachments(f.evidence, bad), { code: 'resource-unavailable' });
  }
  assert.throws(() => externalAttachments(f.evidence, { attachments: [f.source.attachments[0], f.source.attachments[0]] }), { code: 'resource-unavailable' });
  assert.throws(() => externalAttachments(f.evidence, { attachments: [{ ...f.source.attachments[0], size: 20 * 1024 * 1024 + 1 }] }), { code: 'artifact-too-large' });
});

test('read refreshes the original source URL, matching file metadata and exact child route', async () => {
  for (const thread of [true, false]) {
    const f = fixture(thread); f.source.attachments[0].url += '&refreshed=yes';
    assert.deepEqual(await collect(await readExternalFile(f.api, account, f.route, f.attachment, f.options)), bytes);
    assert.equal(f.downloads[0].url.endsWith('refreshed=yes'), true);
    assert.equal(f.downloads[0].channelId, thread ? id.thread : id.channel);
    f.source.attachments[0].size++;
    await assert.rejects(readExternalFile(f.api, account, f.route, f.attachment, f.options), { code: 'stale-route' });
    assert.equal(f.downloads.length, 1);
  }
});

test('changed author/attachment/name/MIME, removed own mention and foreign parent never download', async () => {
  for (const mutate of [ f => { f.source.author.id = id.bot; }, f => { f.source.attachments[0].id = id.sent; },
    f => { f.source.attachments[0].filename = 'new.txt'; }, f => { f.source.attachments[0].content_type = 'application/pdf'; },
    f => { f.source.mentions = []; }, f => { f.child.parent_id = id.human; } ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(readExternalFile(f.api, account, f.route, f.attachment, f.options), { code: 'stale-route' });
    assert.equal(f.downloads.length, 0);
  }
});

test('declared/actual byte mismatch and consumer revocation cancel streams without accepting bytes', async () => {
  for (const body of [Buffer.from('short'), Buffer.alloc(bytes.length + 1)]) {
    const f = fixture(); let closed = false;
    f.api.downloadFileStream = async () => ({ stream: (async function* () { try { yield body; } finally { closed = true; } })() });
    const stream = await readExternalFile(f.api, account, f.route, f.attachment, f.options);
    await assert.rejects(collect(stream), { code: body.length > bytes.length ? 'artifact-too-large' : 'resource-unavailable' });
    assert.equal(closed, true);
  }
  const f = fixture(); let cancelled = 0;
  f.api.downloadFileStream = async () => ({ length: '999999', cancel: async () => { cancelled++; }, stream: (async function* () { yield bytes; })() });
  await assert.rejects(readExternalFile(f.api, account, f.route, f.attachment, f.options), { code: 'resource-unavailable' });
  assert.equal(cancelled, 1);
  let active = true; let closed = false;
  f.api.downloadFileStream = async () => ({ stream: (async function* () { try { yield bytes.subarray(0, 2); active = false; yield bytes.subarray(2); } finally { closed = true; } })() });
  const stream = await readExternalFile(f.api, account, f.route, f.attachment,
    { assertCurrent: () => { if (!active) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); } });
  await assert.rejects(collect(stream), { code: 'cancelled' }); assert.equal(closed, true);
});

test('CDN request has no authorization, forbids redirect/foreign host/channel/file/path and closes abandoned body', async () => {
  const f = fixture(); let calls = 0; let cancelled = false;
  const api = new DiscordApi({ token, fetchImpl: async (url, request) => {
    calls++; assert.equal(request.headers, undefined); assert.equal(request.redirect, 'error');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } }));
  } });
  const input = { url: f.source.attachments[0].url, channelId: id.thread, attachmentId: id.attachment, fileName: 'input.txt' };
  for (const url of ['http://cdn.discordapp.com', input.url.replace('cdn.discordapp.com', 'evil.example'),
    input.url.replace(id.thread, id.channel), input.url.replace(id.attachment, id.human), input.url.replace('/input.txt', '/other.txt'),
    input.url.replace('https://', 'https://user@'), input.url + '#fragment'])
    await assert.rejects(api.downloadFileStream({ ...input, url }), { code: 'resource-unavailable' });
  assert.equal(calls, 0);
  const downloaded = await api.downloadFileStream(input); await downloaded.cancel(); assert.equal(cancelled, true);
});

test('CDN HTTP failures, redirect transport failure and aborted reads produce no stream', async () => {
  const f = fixture(); const input = { url: f.source.attachments[0].url, channelId: id.thread, attachmentId: id.attachment, fileName: 'input.txt' };
  for (const status of [302, 403, 404, 500]) {
    const api = new DiscordApi({ token, fetchImpl: async () => new Response('', { status }) });
    await assert.rejects(api.downloadFileStream(input), { code: 'resource-unavailable' });
  }
  const api = new DiscordApi({ token, fetchImpl: async () => { throw new TypeError('redirect blocked'); } });
  await assert.rejects(api.downloadFileStream(input), { code: 'resource-unavailable' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.downloadFileStream({ ...input, signal: controller.signal }), { name: 'AbortError' });
});

test('native file permission, source, Host fence and lease are checked before a single original-thread reply', async () => {
  const f = fixture(); f.guild.roles[0].permissions = String(permissions & ~(1n << 15n));
  await assert.rejects(replyExternalFile(f.api, account, f.route, f.file, f.options), { code: 'reply-permission-denied' });
  f.guild.roles[0].permissions = String(permissions);
  await assert.rejects(replyExternalFile(f.api, account, f.route, f.file, { ...f.options, beforeSend: () => false }), { code: 'stale-route' });
  const controller = new AbortController();
  await assert.rejects(replyExternalFile(f.api, account, f.route, f.file, { ...f.options, signal: controller.signal,
    beforeSend: () => { controller.abort(); return true; } }), { name: 'AbortError' });
  assert.equal(f.sends.length, 0);
  assert.deepEqual(await replyExternalFile(f.api, account, f.route, f.file, f.options), { sent: true });
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].channelId, id.thread);
  assert.equal(f.sends[0].replyToMessageId, id.message); assert.equal(f.sends[0].retry, false); assert.equal(f.sends[0].failIfNotExists, true);
});

test('lost/invalid receipt is unknown and definite native rejection is distinct, never retried', async () => {
  for (const change of [{ author: { id: id.human, bot: true } }, { channel_id: id.channel }, { message_reference: {} },
    { attachments: [{ id: id.sent, filename: 'wrong.txt', size: bytes.length }] }, { attachments: [] }]) {
    const f = fixture(); Object.assign(f.result, change);
    await assert.rejects(replyExternalFile(f.api, account, f.route, f.file, f.options), { code: 'reply-result-unknown' });
    assert.equal(f.sends.length, 1);
  }
  for (const [input, output] of [['artifact-rate-limited', 'file-provider-rejected'], ['artifact-too-large', 'artifact-too-large'],
    ['artifact-delivery-uncertain', 'reply-result-unknown']]) {
    const f = fixture(); let sends = 0; f.api.createFileMessage = async () => { sends++; throw Object.assign(new Error(input), { code: input }); };
    await assert.rejects(replyExternalFile(f.api, account, f.route, f.file, f.options), { code: output }); assert.equal(sends, 1);
  }
});

test('checked multipart native API keeps true reference failure, disables mentions and never retries 429', async () => {
  let calls = 0; const f = fixture();
  const api = new DiscordApi({ token, fetchImpl: async (url, request) => {
    calls++; const payload = JSON.parse(request.body.get('payload_json'));
    assert.equal(payload.message_reference.fail_if_not_exists, true); assert.equal(payload.message_reference.message_id, id.message);
    assert.deepEqual(payload.allowed_mentions, { parse: [], replied_user: false });
    assert.equal(request.body.get('files[0]').name, 'result.txt');
    return Response.json({ message: 'limited', retry_after: 0.1 }, { status: 429 });
  } });
  await assert.rejects(api.createFileMessage({ channelId: id.thread, replyToMessageId: id.message,
    file: { fileName: f.file.name, bytes }, retry: false, failIfNotExists: true }), { code: 'artifact-rate-limited' });
  assert.equal(calls, 1);
});


test('revocation cancels an in-flight stalled CDN reader, and raw body errors do not expose signed URLs', async () => {
  const f = fixture(); const input = { url: f.source.attachments[0].url, channelId: id.thread, attachmentId: id.attachment, fileName: 'input.txt' };
  let cancelled = false;
  const api = new DiscordApi({ token, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  const controller = new AbortController();
  const downloaded = await api.downloadFileStream({ ...input, signal: controller.signal });
  const next = downloaded.stream[Symbol.asyncIterator]().next(); controller.abort();
  await assert.rejects(next, { name: 'AbortError' }); assert.equal(cancelled, true);
  const failed = new DiscordApi({ token, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(input.url)); }
  })) });
  const stream = (await failed.downloadFileStream(input)).stream;
  await assert.rejects(collect(stream), error => error.code === 'resource-unavailable' && !error.message.includes('https'));
});
