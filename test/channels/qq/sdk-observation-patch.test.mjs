import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { patchQqObservationSource, qqSdkObservationPatch } from '../../../plugin-src/host/qq-sdk-observation-patch.mjs';

const packageRoot = resolve(import.meta.dirname, '../../..');
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('build patch refuses changed SDK input and unknown files instead of applying guessed edits', async () => {
  const sdk = await readFile(join(packageRoot, 'node_modules/@tencent-connect/qqbot-nodejs/dist/QQBot.js'), 'utf8');
  assert.match(patchQqObservationSource('QQBot.js', sdk), /onGatewayObservation/);
  assert.throws(() => patchQqObservationSource('QQBot.js', sdk + '\n'), /exact reviewed/);
  assert.throws(() => patchQqObservationSource('other.js', sdk), /exact reviewed/);
});

test('the production build patch observes real WS messages before decode and preserves actual Runtime intake/reply', async t => {
  const directory = await mkdtemp(join(packageRoot, '.qq-sdk-observation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await build({
    stdin: { contents: 'export { QqRuntime } from "./src/channels/qq/qq-runtime.mjs";', resolveDir: packageRoot },
    bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['ws'],
    plugins: [qqSdkObservationPatch], write: false,
  });
  const modulePath = join(directory, 'runtime.mjs');
  await writeFile(modulePath, output.outputFiles[0].contents);
  const { QqRuntime } = await import(pathToFileURL(modulePath));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  let socket;
  server.on('connection', current => {
    socket = current;
    current.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    current.on('message', bytes => {
      if (JSON.parse(bytes).op === 2) current.send(JSON.stringify({ op: 0, s: 1, t: 'READY',
        d: { session_id: 'private-session', user: { id: 'private-bot' } } }));
    });
  });
  const nativePosts = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (target, options) => {
    if (String(target).includes('getAppAccessToken')) return json({ access_token: 'private-token', expires_in: 7200 });
    if (String(target).endsWith('/gateway')) return json({ url: `ws://127.0.0.1:${server.address().port}` });
    if (options?.method === 'POST') { nativePosts.push(JSON.parse(options.body)); return json({ id: 'private-receipt' }); }
    return json({ id: 'private-bot' });
  };
  const records = [];
  const logs = [];
  const admitted = [];
  const runtime = new QqRuntime({ config: { appId: 'test-app', botId: 'test-bot', consumerMode: 'external-consumer' },
    appSecret: 'private-secret', state: {}, harness: {},
    externalConsumer: async event => { admitted.push(event); return { accepted: true }; },
    logger: { info: (...args) => { logs.push(args); records.push(...args.filter(value => value?.event)); },
      error: (...args) => logs.push(args), warn() {} },
  });
  t.after(async () => {
    await runtime.stop();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = previousFetch;
  });
  await runtime.start();
  socket.send('private-invalid-json');
  socket.send(JSON.stringify({ op: 999, d: { token: 'private-token' }, t: 'private-event' }));
  socket.send(JSON.stringify({ op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE', d: {
    id: 'private-message', group_openid: 'private-group', content: 'private-question',
    author: { member_openid: 'private-human', bot: false }, timestamp: new Date().toISOString(),
  } }));
  const deadline = Date.now() + 5_000;
  while (admitted.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(admitted.length, 1);
  const transport = records.filter(value => value.event === 'qq.native-transport.frame');
  assert.ok(transport.some(value => value.phase === 'parse-refused'));
  assert.ok(transport.some(value => value.phase === 'decoded' && value.opcode === 'other'));
  const gateway = records.find(value => value.event === 'qq.native-gateway.frame');
  assert.ok(transport.some(value => value.phase === 'decoded' && value.connection === gateway.transport.connection && value.frame === gateway.transport.frame));
  const pairs = new Map();
  for (const value of transport) {
    const key = `${value.connection}/${value.frame}`;
    pairs.set(key, [...(pairs.get(key) ?? []), value.phase]);
  }
  assert.ok([...pairs.values()].every(phases => phases[0] === 'received' && ['decoded', 'parse-refused'].includes(phases[1])));
  const reply = await runtime.replyChecked(admitted[0].reply, 'answer', { receipt: true, beforeSend: () => true });
  assert.equal(reply.receipt.messageId, 'private-receipt');
  assert.equal(nativePosts.length, 1);
  assert.equal(admitted.length, 1);
  for (const text of ['private-secret', 'private-token', 'private-session', 'private-invalid-json', 'private-event', 'private-question', 'private-human'])
    assert.equal(JSON.stringify(logs).includes(text), false, `diagnostic leaked ${text}`);
});
