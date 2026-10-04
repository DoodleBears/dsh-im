import test from 'node:test';
import assert from 'node:assert/strict';
import { externalAttachments, readExternalFile, replyExternalFile } from '../../../src/channels/slack/external-files.mjs';
import { SlackApi } from '../../../src/channels/slack/slack-api.mjs';

const route = { messageId: '1791127736.123456', conversationId: 'C12345678', actorId: 'U87654321', threadId: '1791127600.000001', rootId: '1791127600.000001' };
const native = { files: [{ id: 'F12345678', name: 'source.zip', mode: 'hosted', size: 3 }] };
const fileInfo = { ...native.files[0], url_private_download: 'https://files.slack.com/files-pri/T123-F123/source.zip' };
const result = { id: 'result', name: 'result.zip', bytes: Buffer.from('xyz') };
const assertCurrent = () => {};
const source = async () => native;
async function metadata() { return (await externalAttachments({ reply: route }, source)).attachments[0]; }

for (const alteration of [
  { id: 'F99999999' }, { name: 'renamed.zip' }, { deleted: true }, { mode: 'external' },
]) test(`read refuses changed file association ${JSON.stringify(alteration)}`, async () => {
  const attachment = await metadata();
  let reads = 0;
  const api = { fileInfo: async () => { reads++; return fileInfo; } };
  await assert.rejects(readExternalFile(api, route, attachment, { assertCurrent,
    source: async () => ({ files: [{ ...native.files[0], ...alteration }] }) }));
  assert.equal(reads, 0);
});

test('bounded stream checks exact byte count, oversize chunks, and current authorization', async () => {
  const attachment = await metadata();
  const api = { fileInfo: async () => fileInfo,
    downloadFileStream: async () => ({ stream: (async function* () { yield Buffer.from('abc'); })() }) };
  const stream = await readExternalFile(api, route, attachment, { source, assertCurrent });
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'abc');
  for (const bytes of ['ab', 'abcd']) {
    api.downloadFileStream = async () => ({ stream: (async function* () { yield Buffer.from(bytes); })() });
    await assert.rejects(async () => { for await (const _ of await readExternalFile(api, route, attachment, { source, assertCurrent })) {} });
  }
  let current = true;
  api.downloadFileStream = async () => { current = false; return { stream: (async function* () { yield Buffer.from('abc'); })() }; };
  await assert.rejects(readExternalFile(api, route, attachment, { source, assertCurrent: () => { if (!current) throw Error('revoked'); } }), /revoked/);
});

test('file preparation can finish but a replaced source prevents the visible thread completion', async () => {
  let allowed = true;
  let completed = 0;
  const api = { uploadFile: async request => {
    assert.equal(request.channelId, route.conversationId);
    assert.equal(request.threadTs, route.threadId);
    allowed = false;
    await request.beforeSend();
    completed++;
  } };
  await assert.rejects(replyExternalFile(api, route, result, { assertCurrent,
    source: async () => { if (!allowed) throw Object.assign(Error('stale-route'), { code: 'stale-route' }); return native; } }), { code: 'stale-route' });
  assert.equal(completed, 0);
});

for (const code of ['artifact-provider-failed', 'artifact-permission-required', 'artifact-delivery-uncertain'])
  test(`file reply preserves definite versus uncertain ${code}`, async () => {
    let calls = 0;
    await assert.rejects(replyExternalFile({ uploadFile: async () => { calls++; throw Object.assign(Error(code), { code }); } }, route, result,
      { source, assertCurrent }), { code: code === 'artifact-provider-failed' ? 'file-upload-failed'
        : code === 'artifact-permission-required' ? 'file-provider-rejected' : code });
    assert.equal(calls, 1);
  });

test('native API fence runs after raw upload and before completion with no retry', async () => {
  const calls = [];
  const api = new SlackApi({ botToken: 'xoxb-test-1234567890123456', fetchImpl: async (url, options) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith('files.getUploadURLExternal')) return Response.json({ ok: true, file_id: 'F12345678', upload_url: 'https://files.slack.com/upload/ticket' });
    if (url.pathname.startsWith('/upload/')) { assert.equal(options.headers.authorization, undefined); return new Response('OK'); }
    throw Error('Completion must not run');
  } });
  await assert.rejects(api.uploadFile({ channelId: route.conversationId, threadTs: route.threadId,
    file: { fileName: result.name, bytes: result.bytes }, beforeSend: () => { throw Error('revoked'); } }), /revoked/);
  assert.deepEqual(calls, ['/api/files.getUploadURLExternal', '/upload/ticket']);
});

for (const url of ['https://evil.test/files-pri/a', 'http://files.slack.com/files-pri/a', 'https://files.slack.com:444/files-pri/a', 'https://files.slack.com/upload/a'])
  test(`file download rejects unsafe endpoint ${url}`, async () => {
    let calls = 0;
    const api = new SlackApi({ botToken: 'xoxb-test-1234567890123456', fetchImpl: async () => { calls++; throw Error('Must not fetch'); } });
    await assert.rejects(api.downloadFileStream({ url }));
    assert.equal(calls, 0);
  });

test('private file redirect is blocked without sending credentials to the redirect host', async () => {
  let calls = 0;
  const api = new SlackApi({ botToken: 'xoxb-test-1234567890123456', fetchImpl: async (_url, request) => {
    calls++; assert.equal(request.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://evil.test/file' } });
  } });
  await assert.rejects(api.downloadFileStream({ url: fileInfo.url_private_download }));
  assert.equal(calls, 1);
});
