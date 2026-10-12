import assert from 'node:assert/strict';
import test from 'node:test';
import { QqNativeReplyObservations } from '../../../src/channels/qq/native-reply-observations.mjs';

function fixture() {
  const records = [];
  const observer = new QqNativeReplyObservations({
    account: { userId: 'authenticated-bot', fingerprint: 'a'.repeat(64) },
    report: record => records.push(record),
  });
  const message = (id, overrides = {}) => ({
    kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', messageId: id,
    groupOpenid: 'native-group', senderId: 'native-member', senderIsBot: true,
    content: 'private message content', ...overrides,
  });
  return { observer, records, message };
}

test('a send receipt alone never creates a native observation', () => {
  const { observer, records } = fixture();
  observer.sent('native-group', 'sent-id');
  assert.deepEqual(records, []);
});

test('correlation requires an actual bot callback with the same app-local group and native receipt ID', () => {
  const { observer, records, message } = fixture();
  observer.sent('native-group', 'sent-id');
  observer.receive(message('sent-id', { senderIsBot: false }));
  observer.receive(message('other-id'));
  observer.receive(message('sent-id', { groupOpenid: 'other-group' }));
  observer.receive(message('sent-id'));
  observer.receive(message('sent-id'));
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(record => record.receiptMatched), [false, false, true]);
  assert.equal(records[2].senderMatchesAuthenticatedBot, false);
  assert.equal(records[2].senderIsBot, true);
  assert.equal(records[2].eventType, 'GROUP_MESSAGE_CREATE');
  assert.ok(!JSON.stringify(records).includes('private message content'));
  assert.ok(!JSON.stringify(records).includes('native-group'));
  assert.ok(!JSON.stringify(records).includes('native-member'));
  assert.ok(!JSON.stringify(records).includes('sent-id'));
});

test('a native callback arriving before its receipt remains an observation, then correlates once', () => {
  const { observer, records, message } = fixture();
  observer.receive(message('early', { senderId: 'authenticated-bot' }));
  observer.sent('native-group', 'early');
  observer.sent('native-group', 'early');
  assert.deepEqual(records.map(record => record.receiptMatched), [false, true]);
  assert.equal(records[1].senderMatchesAuthenticatedBot, true);
});

test('observations are bounded, expire and cannot cross independent authenticated instances', t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const a = fixture();
  const b = fixture();
  a.observer.sent('native-group', 'same-id');
  b.observer.receive(b.message('same-id'));
  assert.equal(b.records[0].receiptMatched, false);
  now = 300_001;
  a.observer.receive(a.message('same-id'));
  assert.equal(a.records[0].receiptMatched, false);
  for (let index = 0; index < 129; index++) a.observer.sent('native-group', `bounded-${index}`);
  a.observer.receive(a.message('bounded-0'));
  assert.equal(a.records.at(-1).receiptMatched, false);
});

test('invalid or unrelated input and aborted lifetimes do not produce observations or affect delivery', () => {
  const { observer, records, message } = fixture();
  for (const invalid of [undefined, message(''), message('x', { kind: 'c2c' }),
    message('x', { rawEventType: 'OTHER_EVENT' }), message('x', { groupOpenid: ' ' })])
    observer.receive(invalid);
  const abort = new AbortController();
  abort.abort();
  observer.receive(message('cancelled'), abort.signal);
  observer.sent('native-group', 'cancelled', abort.signal);
  assert.deepEqual(records, []);
  const broken = new QqNativeReplyObservations({
    account: { userId: 'bot', fingerprint: 'b'.repeat(64) },
    report: () => { throw new Error('diagnostic sink failed'); },
  });
  assert.doesNotThrow(() => broken.receive(message('sink-failure')));
});

test('candidate diagnostics are rate limited and later report suppressed observations', t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const { observer, records, message } = fixture();
  for (let index = 0; index < 70; index++) observer.receive(message(`candidate-${index}`));
  assert.equal(records.length, 64);
  now = 60_000;
  observer.receive(message('next-window'));
  assert.equal(records.length, 65);
  assert.equal(records.at(-1).suppressed, 6);
});

test('metadata diagnostics distinguish unqualified native callbacks from actual receipts without creating Echo', () => {
  const records = [], frames = [];
  const observer = new QqNativeReplyObservations({
    account: { userId: 'authenticated-bot', fingerprint: 'a'.repeat(64) },
    report: record => records.push(record), reportFrame: record => frames.push(record),
  });
  const message = { kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE',
    messageId: 'native-reply-id', groupOpenid: 'private-group', senderId: 'group-scoped-author',
    content: 'private body', raw: { authorization: 'private credential' } };
  observer.receive(message);
  observer.sent('private-group', 'native-reply-id');
  observer.receive(message);
  observer.sent('private-group', 'native-reply-id');
  assert.deepEqual(frames.map(record => record.phase), ['callback', 'receipt']);
  assert.equal(frames[0].senderBotFlag, 'absent');
  assert.equal(frames[0].senderMatchesAuthenticatedBot, false);
  assert.equal(frames[0].messageHash, frames[1].messageHash);
  assert.equal(frames[0].conversationHash, frames[1].conversationHash);
  assert.deepEqual(records, []);
  for (const value of ['private-group', 'native-reply-id', 'group-scoped-author', 'private body', 'private credential'])
    assert.ok(!JSON.stringify(frames).includes(value));
});

test('frame diagnostics have an independent rate and duplicate bound without starving native candidates', t => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  const frames = [], records = [];
  const observer = new QqNativeReplyObservations({
    account: { userId: 'authenticated-bot', fingerprint: 'a'.repeat(64) },
    report: record => records.push(record), reportFrame: record => frames.push(record),
  });
  const message = id => ({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    messageId: id, groupOpenid: 'group', senderId: 'human', senderIsBot: false });
  for (let index = 0; index < 70; index++) observer.receive(message(`human-${index}`));
  observer.receive({ ...message('own'), senderId: 'authenticated-bot', senderIsBot: true });
  assert.equal(frames.length, 64);
  assert.equal(records.length, 1);
  now = 60_000;
  observer.receive(message('new-window'));
  assert.equal(frames.at(-1).suppressed, 7);
  assert.equal(frames.at(-1).senderBotFlag, 'false');
  observer.receive(message('new-window'));
  assert.equal(frames.length, 65);
  now = 360_001;
  observer.receive(message('new-window'));
  assert.equal(frames.length, 66);
});

test('invalid and aborted frames remain absent and diagnostic sink failure cannot change delivery', () => {
  const frames = [];
  const observer = new QqNativeReplyObservations({
    account: { userId: 'bot', fingerprint: 'a'.repeat(64) }, report: () => {},
    reportFrame: record => frames.push(record),
  });
  const signal = AbortSignal.abort();
  observer.receive({ kind: 'group', rawEventType: 'OTHER', messageId: 'id', groupOpenid: 'group' });
  observer.sent(' ', 'id');
  observer.receive({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', messageId: 'id', groupOpenid: 'group' }, signal);
  observer.sent('group', 'id', signal);
  assert.deepEqual(frames, []);
  const broken = new QqNativeReplyObservations({ account: { userId: 'bot', fingerprint: 'a'.repeat(64) },
    report: () => {}, reportFrame: () => { throw Error('sink failure'); } });
  assert.doesNotThrow(() => broken.sent('group', 'id'));
});

test('frame duplicate memory evicts old entries and separates independent authenticated Apps', t => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  const a = [], b = [];
  const first = new QqNativeReplyObservations({ account: { userId: 'bot-a', fingerprint: 'a'.repeat(64) },
    report: () => {}, reportFrame: record => a.push(record) });
  const second = new QqNativeReplyObservations({ account: { userId: 'bot-b', fingerprint: 'b'.repeat(64) },
    report: () => {}, reportFrame: record => b.push(record) });
  for (let index = 0; index < 129; index++) {
    now = Math.floor(index / 60) * 60_000;
    first.sent('group', `receipt-${index}`);
  }
  first.sent('group', 'receipt-0');
  assert.equal(a.length, 130);
  second.sent('group', 'receipt-0');
  assert.equal(b.length, 1);
  assert.notEqual(a.at(-1).accountFingerprint, b[0].accountFingerprint);
  assert.equal(a.at(-1).messageHash, b[0].messageHash);
});
