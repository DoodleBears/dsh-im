import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckedWeixinTyping } from '../../../src/channels/weixin/external-typing.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const states = [];
  const controller = new AbortController();
  let allowed = true;
  const api = {
    async getConfig() { return { typingTicket: 'private-ticket' }; },
    async sendTyping(input) { calls.push(input.status); return true; },
    ...overrides,
  };
  const typing = new CheckedWeixinTyping({ api, baseUrl: 'https://example.test', token: 'private-token',
    intervalMs: 10, maximumMs: 100, logger: { warn() {} } });
  const start = () => typing.start({ toUserId: 'owner', contextToken: 'private-context',
    signal: controller.signal, validate: () => allowed, onState: state => states.push(state) });
  t.after(() => typing.close());
  return { typing, start, calls, states, controller, revoke: () => { allowed = false; } };
}

test('checked typing renews only while actual work has current authority and cancels once', async t => {
  const f = fixture(t);
  const lease = await f.start();
  assert.equal(lease.accepted, true);
  t.mock.timers.tick(10);
  await flush();
  assert.deepEqual(f.calls, [1, 1]);
  await lease.stop();
  await lease.stop();
  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(f.calls, [1, 1, 2]);
  assert.equal(f.typing.status.phase, 'idle');
  assert.ok(!JSON.stringify(f.states).includes('private-'));
});

test('revocation at renewal prevents another start and permits original-ticket cleanup', async t => {
  const f = fixture(t);
  await f.start();
  f.revoke();
  t.mock.timers.tick(10);
  await flush();
  assert.deepEqual(f.calls, [1, 2]);
  assert.equal(f.typing.status.reason, 'renewal-refused');
});

test('cancelled configuration lookup cannot start a late indicator', async t => {
  let resolve;
  const config = new Promise(done => { resolve = done; });
  const f = fixture(t, { getConfig: () => config });
  const pending = f.start();
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  await flush();
  f.controller.abort();
  resolve({ typingTicket: 'private-ticket' });
  await rejected;
  assert.deepEqual(f.calls, []);
});

test('work cancellation cleans up after an uncertain initial typing dispatch', async t => {
  const calls = [];
  const f = fixture(t, { sendTyping(input) {
    calls.push(input.status);
    if (input.status === 2) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      input.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  } });
  const rejected = assert.rejects(f.start(), { code: 'cancelled' });
  await flush();
  f.controller.abort();
  await rejected;
  assert.deepEqual(calls, [1, 2]);
});

test('the maximum lifetime cancels even without Host completion', async t => {
  const f = fixture(t);
  await f.start();
  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(f.calls, [1, 2]);
  assert.equal(f.typing.status.reason, 'maximum-duration');
});

test('missing native ticket is reported honestly without a typing send', async t => {
  const f = fixture(t, { async getConfig() { return {}; } });
  await assert.rejects(f.start(), { code: 'typing-unavailable' });
  assert.deepEqual(f.calls, []);
});

test('disposal cancels a live indicator and leaves no renewal', async t => {
  const f = fixture(t);
  await f.start();
  await f.typing.close();
  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(f.calls, [1, 2]);
  assert.equal(f.typing.status.reason, 'disposed');
});

test('a failed cancellation is labelled unconfirmed, never successful cleanup', async t => {
  const f = fixture(t, { async sendTyping(input) {
    if (input.status === 2) throw new Error('private-ticket server failure');
    return true;
  } });
  const lease = await f.start();
  await lease.stop();
  assert.equal(f.typing.status.phase, 'cleanup-unconfirmed');
  assert.ok(!JSON.stringify(f.typing.status).includes('private-ticket'));
});
