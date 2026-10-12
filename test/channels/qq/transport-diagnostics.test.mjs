import assert from 'node:assert/strict';
import test from 'node:test';
import { QqNativeTransportDiagnostics } from '../../../src/channels/qq/native-transport-diagnostics.mjs';
import { frameBytes, frameEnvelope, observeFrame } from '../../../src/channels/qq/sdk-frame-observation.mjs';

test('transport metadata has only fixed labels, bounded counters and no raw payload or error text', () => {
  const records = [];
  const observer = new QqNativeTransportDiagnostics({ account: { fingerprint: 'a'.repeat(64) }, report: value => records.push(value) });
  const bytes = Buffer.from('private-payload');
  assert.equal(frameBytes(bytes), bytes.length);
  assert.equal(frameBytes([bytes, bytes]), bytes.length * 2);
  assert.equal(frameBytes(new Uint8Array(bytes)), bytes.length);
  assert.equal(frameBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), bytes.length);
  assert.equal(frameBytes('中'), 3);
  assert.equal(frameBytes({ raw: 'private-secret' }), null);
  const base = { connection: 1, frame: 1, bytes: bytes.length };
  observer.observe({ ...base, phase: 'received', raw: 'private-payload' });
  observer.observe({ ...base, phase: 'decoded', ...frameEnvelope(12345, 'private-event', 'private-session') });
  assert.deepEqual(observer.context, { connection: 1, frame: 1 });
  assert.equal(records[1].opcode, 'other');
  assert.equal(records[1].eventType, 'other');
  assert.equal(records[1].sequence, null);
  observer.observe({ ...base, frame: 2, phase: 'parse-refused', error: 'private-secret' });
  assert.equal(observer.context, undefined);
  observer.observe({ ...base, phase: 'decoded', ...frameEnvelope(0, 'GROUP_MESSAGE_CREATE', 2) });
  assert.equal(records[3].sequence, 2);
  assert.equal(JSON.stringify(records).includes('private'), false);
  assert.ok(records.every(Object.isFrozen));
});

test('transport quota reports later suppression, keeps one current frame and ignores aborted/invalid data', t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const records = [];
  const observer = new QqNativeTransportDiagnostics({ account: { fingerprint: 'a'.repeat(64) }, report: value => records.push(value) });
  const frame = { connection: 1, frame: 1, phase: 'received', bytes: 10 };
  for (let index = 0; index < 130; index++) observer.observe({ ...frame, frame: index + 1 });
  assert.equal(records.length, 128);
  assert.equal(observer.snapshot.received, 130);
  assert.equal(observer.snapshot.suppressed, 2); // Tail suppression is visible without a later log.
  now = 60_000;
  observer.observe(frame);
  assert.equal(records[128].suppressed, 2);
  observer.observe(frame, AbortSignal.abort());
  observer.observe({ ...frame, frame: -1 });
  observer.observe({ ...frame, bytes: Infinity });
  assert.equal(records.length, 129);
  assert.equal(observer.snapshot.received, 131);
  const broken = new QqNativeTransportDiagnostics({ account: { fingerprint: 'a'.repeat(64) }, report() { throw Error('private'); } });
  assert.doesNotThrow(() => broken.observe(frame));
});

test('the SDK observation option isolates synchronous throws and asynchronous rejections', async () => {
  assert.doesNotThrow(() => observeFrame(() => { throw Error('private'); }, { phase: 'received' }));
  observeFrame(() => Promise.reject(Error('private')), { phase: 'received' });
  await new Promise(resolve => setImmediate(resolve));
});
