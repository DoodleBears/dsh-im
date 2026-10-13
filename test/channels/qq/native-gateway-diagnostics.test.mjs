import assert from 'node:assert/strict';
import test from 'node:test';
import { QqNativeGatewayDiagnostics } from '../../../src/channels/qq/native-gateway-diagnostics.mjs';

function fixture(fingerprint = 'a'.repeat(64)) {
  const records = [];
  const observer = new QqNativeGatewayDiagnostics({ botId: 'qa', account: { fingerprint }, report: value => records.push(value) });
  const message = (id = 'wire-id', overrides = {}, type = 'GROUP_MESSAGE_CREATE') => `[qa] Dispatch event: t=${type} payload=${JSON.stringify({
    id, group_openid: 'private-group', author: { member_openid: 'private-bot', bot: true },
    content: 'private-body', authorization: 'private-secret', ...overrides,
  })}`;
  return { records, observer, message };
}

test('pre-dispatch hashes use fixed fields, bound mentions/indexes and never retain raw payload or names', () => {
  const { observer, records, message } = fixture();
  observer.observe(message('wire-id', {
    author: { member_openid: 'private-bot', id: 'alias', username: 'private-name', private: 'private-secret', bot: true },
    message_scene: { ext: ['msg_idx=private-index', ...Array(64).fill('unrelated=private')] },
    mentions: Array.from({ length: 9 }, (_, index) => ({ id: 'private-mention', is_you: index === 0, username: 'private-name' })),
  }));
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0].authorIdentifiers), ['member_openid', 'id']);
  assert.equal(records[0].mentionIdentifiers.length, 8);
  assert.equal(records[0].mentionsTruncated, true);
  assert.equal(records[0].indexEvidenceTruncated, true);
  assert.equal(records[0].messageIndexIdentifier.length, 'private-index'.length);
  assert.equal(records[0].mentionIdentifiers[0].self, true);
  assert.equal(records[0].mentionIdentifiers[1].self, false);
  for (const value of ['wire-id', 'private-group', 'private-bot', 'alias', 'private-body', 'private-secret', 'private-name', 'private-index', 'private-mention'])
    assert.equal(JSON.stringify(records).includes(value), false);
});

test('only the exact account Logger prefix is observed; malformed and oversized records have coded dispositions', () => {
  const { observer, records, message } = fixture();
  observer.observe(message().replace('[qa]', '[other]'));
  observer.observe('token response private-secret');
  observer.observe('[qa] Dispatch event: t=READY payload=private-session');
  observer.observe('[qa] Dispatch event: t=GROUP_MESSAGE_CREATE');
  observer.observe('[qa] Dispatch event: t=GROUP_MESSAGE_CREATE payload={');
  observer.observe(message('', {}));
  observer.observe(message('wire-id', { content: '中'.repeat(90_000) }));
  observer.observe(message('wire-id', { group_openid: undefined }, 'C2C_MESSAGE_CREATE'));
  assert.deepEqual(records.map(value => value.reason ?? value.phase), ['ready', 'format', 'malformed', 'invalid-group-frame', 'oversized', 'non-group']);
  assert.equal(JSON.stringify(records).includes('private'), false);
  assert.equal(JSON.stringify(records).includes('中'), false);
});

test('unexpected native group carriers remain metadata-only with a fixed other label', () => {
  const { observer, records, message } = fixture();
  observer.observe(message('wire-id', {}, 'FUTURE_GROUP_EVENT'));
  assert.equal(records[0].eventType, 'other');
  assert.equal(JSON.stringify(records).includes('FUTURE_GROUP_EVENT'), false);
  assert.equal(records[0].event, 'qq.native-gateway.frame');
  assert.equal(records[0].receiptMatched, undefined);
});

test('Gateway reports have independent rate bounds and report later suppression without invoking the sink beyond quota', t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const { observer, records, message } = fixture();
  for (let index = 0; index < 70; index++) observer.observe(message(`wire-${index}`));
  assert.equal(records.length, 64);
  now = 60_000;
  observer.observe(message('later'));
  assert.equal(records.length, 65);
  assert.equal(records.at(-1).suppressed, 6);
});

test('Gateway duplicate memory expires, evicts and never crosses authenticated instances', t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const first = fixture();
  const second = fixture('b'.repeat(64));
  for (let index = 0; index < 129; index++) {
    now = Math.floor(index / 60) * 60_000;
    first.observer.observe(first.message(`wire-${index}`));
  }
  first.observer.observe(first.message('wire-0'));
  first.observer.observe(first.message('wire-0'));
  assert.equal(first.records.length, 130);
  second.observer.observe(second.message('wire-0'));
  assert.equal(second.records.length, 1);
  assert.notEqual(first.records.at(-1).accountFingerprint, second.records[0].accountFingerprint);
  now = 420_001;
  first.observer.observe(first.message('wire-0'));
  assert.equal(first.records.length, 131);
});

test('aborted observers and failed metadata sinks never throw or grant any delivery authority', () => {
  const { observer, records, message } = fixture();
  observer.observe(message(), AbortSignal.abort());
  assert.equal(records.length, 0);
  const broken = new QqNativeGatewayDiagnostics({ botId: 'qa', account: { fingerprint: 'a'.repeat(64) }, report() { throw Error('private sink failure'); } });
  assert.doesNotThrow(() => broken.observe(message()));
  assert.doesNotThrow(() => observer.observe(null));
});
