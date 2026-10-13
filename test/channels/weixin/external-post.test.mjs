import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveWeixinBotIdentity } from '../../../src/channels/weixin/config-store.mjs';
import { pairedWeixinAccount } from '../../../src/channels/weixin/external-consumer.mjs';
import { WeixinRuntime } from '../../../src/channels/weixin/weixin-runtime.mjs';
import { WeixinStateStore } from '../../../src/channels/weixin/state-store.mjs';
import { WeixinApiError } from '../../../src/channels/weixin/weixin-api.mjs';

const config = { ...deriveWeixinBotIdentity('qa.bot'), accountId: 'qa.bot', ownerUserId: 'owner',
  connectedAt: '2026-10-05T00:00:00Z', baseUrl: 'https://ilinkai.weixin.qq.com/', consumerMode: 'external-consumer' };
const account = pairedWeixinAccount(config, 'token');
const target = { kind: 'user', route: { toUserId: 'owner' } };

async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), 'wechat-post-')), 'state.json');
  const state = await new WeixinStateStore(path).load();
  let calls = 0;
  let effect = async () => ({ providerMessageIds: ['dsh-weixin-ack'], message_id: '18446744073709551615' });
  const runtime = new WeixinRuntime({ config, token: 'token', state,
    harness: { ensureRunning: async () => {}, ask: () => assert.fail('no standalone Session') },
    api: { notifyStart: async () => {}, notifyStop: async () => {},
      getUpdates: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      sendText: async input => { calls++; assert.equal(input.contextToken, 'private-context');
        assert.equal(input.toUserId, 'owner'); return effect(); } } });
  await runtime.start();
  const context = (extra = {}) => state.rememberContextToken({ userId: 'owner', contextToken: 'private-context',
    seq: '1', messageTimeMs: Date.now(), fingerprint: account.fingerprint, expiresAt: Date.now() + 10000, ...extra });
  const post = (options = {}) => runtime.sendProactiveText(target, 'one unsolicited report',
    { account, receipt: true, beforeSend: () => true, ...options });
  return { state, runtime, path, context, post, get calls() { return calls; }, set effect(value) { effect = value; } };
}

test('checked owner-only unsolicited post uses private restored context and separates native ID from client acknowledgement', async () => {
  const f = await fixture();
  try {
    await f.context();
    const restored = await new WeixinStateStore(f.path).load();
    assert.equal(restored.externalPostContext(account), 'private-context');
    assert.ok(!JSON.stringify(restored.snapshot()).includes('private-context'));
    const result = await f.post();
    assert.deepEqual(result.receipt, { version: 1, messageId: 'dsh-weixin-ack',
      serverMessageId: '18446744073709551615', conversationId: 'owner', identityKind: 'client-acknowledgement' });
    assert.deepEqual(f.state.snapshot().sessions, {});
    assert.equal(f.calls, 1);
  } finally { await f.runtime.stop(); }
});

for (const kind of ['missing', 'expired', 'rotation', 'revoked', 'cancelled', 'foreign-owner']) {
  test(`checked post refuses ${kind} without any native send`, async () => {
    const f = await fixture();
    try {
      if (kind !== 'missing') await f.context(kind === 'expired' ? { expiresAt: 1 } : {});
      const abort = new AbortController();
      if (kind === 'cancelled') abort.abort();
      await assert.rejects(f.post({ signal: abort.signal,
        account: kind === 'rotation' ? pairedWeixinAccount(config, 'new-token')
          : kind === 'foreign-owner' ? { ...account, ownerUserId: 'stranger' } : account,
        beforeSend: () => kind !== 'revoked' }));
      assert.equal(f.calls, 0);
    } finally { await f.runtime.stop(); }
  });
}

test('known native rejection is actionable, uncertain network stays uncertain, and neither retries', async () => {
  const f = await fixture();
  try {
    await f.context();
    f.effect = async () => { throw new WeixinApiError('send-rejected', 'private native detail', { providerCode: '-2' }); };
    await assert.rejects(f.post(), { code: 'private-context-rejected', message: 'private-context-rejected' });
    assert.equal(f.calls, 1);
    f.effect = async () => { throw new WeixinApiError('network-error', 'uncertain'); };
    await assert.rejects(f.post(), { code: 'network-error' });
    assert.equal(f.calls, 2);
    f.effect = async () => ({ providerMessageIds: ['dsh-weixin-ack'] });
    const result = await f.post();
    assert.equal(result.receipt.serverMessageId, undefined);
    assert.equal(result.receipt.identityKind, 'client-acknowledgement');
  } finally { await f.runtime.stop(); }
});

test('late and duplicate inbound contexts cannot overwrite or extend the latest private capability', async () => {
  const f = await fixture();
  try {
    await f.context({ seq: '20' });
    await f.context({ seq: '19', contextToken: 'old-context' });
    assert.equal(f.state.externalPostContext(account), 'private-context');
    await f.context({ seq: '20', contextToken: 'duplicate-context' });
    assert.equal(f.state.externalPostContext(account), 'private-context');
  } finally { await f.runtime.stop(); }
});
