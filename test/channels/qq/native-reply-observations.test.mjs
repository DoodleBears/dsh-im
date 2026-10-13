import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('identifier evidence distinguishes native author fields and message aliases without changing Echo authority', () => {
  const frames = [], candidates = [];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const observer = new QqNativeReplyObservations({ account: { userId: 'authenticated-user', fingerprint: 'a'.repeat(64) },
    report: record => candidates.push(record), reportFrame: record => frames.push(record) });
  observer.receive({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', messageId: 'callback-id',
    groupOpenid: 'group', senderId: 'group-member', senderIsBot: true, msgIdx: 'parsed-index',
    raw: { id: 'callback-id', message_id: 'alternate-id', content: 'private body',
      author: { member_openid: 'group-member', id: 'authenticated-user', username: 'private name',
        authorization: 'private credential' }, private_future_id: 'not-whitelisted' } });
  observer.sent('group', 'receipt-id', undefined, { id: 'receipt-id', message_id: 'alternate-id',
    content: 'private reply', token: 'private token', timestamp: 1 });
  assert.equal(frames[0].authenticatedUser.hash, hash('authenticated-user'));
  assert.equal(frames[0].senderIdentifier.hash, hash('group-member'));
  assert.equal(frames[0].authorIdentifiers.id.hash, frames[0].authenticatedUser.hash);
  assert.deepEqual(Object.keys(frames[0].authorIdentifiers), ['member_openid', 'id']);
  assert.equal(frames[0].messageIndexIdentifier.hash, hash('parsed-index'));
  assert.equal(frames[0].messageIdentifiers.message_id.hash, frames[1].messageIdentifiers.message_id.hash);
  assert.notEqual(frames[0].messageHash, frames[1].messageHash);
  assert.equal(frames[1].messageIdentifiers.id.length, 'receipt-id'.length);
  assert.deepEqual(Object.keys(frames[1].messageIdentifiers), ['id', 'message_id']);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].receiptMatched, false);
  assert.equal(candidates[0].senderMatchesAuthenticatedBot, false);
  for (const value of ['authenticated-user', 'group-member', 'callback-id', 'receipt-id', 'alternate-id',
    'parsed-index', 'private body', 'private name', 'private credential', 'not-whitelisted', 'private reply', 'private token'])
    assert.ok(!JSON.stringify(frames).includes(value));
});

test('malformed diagnostic fields cannot break native candidate correlation or execute identifier getters', () => {
  const candidates = [];
  const observer = new QqNativeReplyObservations({ account: { userId: 'bot', fingerprint: 'a'.repeat(64) },
    report: record => candidates.push(record), reportFrame: () => {} });
  const response = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('diagnostic metadata'); } });
  assert.doesNotThrow(() => observer.sent('group', 'reply', undefined, response));
  const raw = { get author() { throw Error('diagnostic metadata'); } };
  assert.doesNotThrow(() => observer.receive({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE',
    messageId: 'reply', groupOpenid: 'group', senderId: 'bot', senderIsBot: true, raw }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].receiptMatched, true);
  let accessed = 0;
  observer.sent('group', 'other', undefined, { get id() { accessed++; throw Error('getter'); } });
  assert.equal(accessed, 0);
});

test('native reference and mention evidence stays diagnostic, bounded and separate from receipt authority', () => {
  const frames = [], candidates = [];
  const observer = new QqNativeReplyObservations({ account: { userId: 'global-user', fingerprint: 'a'.repeat(64) },
    nativeUser: { id: 'global-user', union_openid: 'alternate-user', username: 'private name' },
    report: record => candidates.push(record), reportFrame: record => frames.push(record) });
  observer.sent('group', 'receipt-id', undefined, { id: 'receipt-id', ext_info: {
    ref_idx: 'native-reference', private_info: 'private credential' } });
  observer.receive({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', groupOpenid: 'group',
    messageId: 'callback-id', senderId: 'group-member', senderIsBot: true, msgIdx: 'native-reference',
    mentions: Array.from({ length: 40 }, (_, index) => ({ is_you: index === 0, id: 'group-member',
      nickname: 'private name', content: 'private body' })) });
  assert.equal(frames[0].messageIndexIdentifier.hash, frames[1].messageIndexIdentifier.hash);
  assert.equal(frames[1].mentionIdentifiers.length, 8);
  assert.equal(frames[1].mentionIdentifiers[0].self, true);
  assert.equal(frames[1].mentionIdentifiers[1].self, false);
  assert.equal(frames[1].mentionIdentifiers[0].identifiers.id.hash, frames[1].senderIdentifier.hash);
  assert.deepEqual(Object.keys(frames[1].authenticatedUserIdentifiers), ['id', 'union_openid']);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].receiptMatched, false);
  for (const value of ['native-reference', 'global-user', 'alternate-user', 'group-member', 'private name',
    'private body', 'private credential', 'private_info', 'nickname', 'content'])
    assert.ok(!JSON.stringify(frames).includes(value));
});
