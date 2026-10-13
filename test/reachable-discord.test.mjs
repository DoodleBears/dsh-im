import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscordReachable } from '../src/channels/discord/reachable-conversations.mjs';

function fixture(count = 2) {
  let live = true;
  let effects = 0;
  const channels = Array.from({ length: count }, (_, i) => ({
    id: String(40000 + i),
    guild_id: '10000',
    type: 0,
    name: `channel-${i}`,
    permission_overwrites: [],
  }));
  const guild = {
    id: '10000',
    owner_id: '19999',
    roles: [{ id: '10000', permissions: String((1n << 10n) | (1n << 11n)) }],
  };
  const checked = {
    account: { userId: '20000' },
    signal: new AbortController().signal,
    assertCurrent() {
      if (!live) throw Object.assign(new Error('stopped'), { code: 'capability-unavailable' });
    },
    api: {
      listCurrentGuilds: async () => [{ id: '10000', name: 'QA' }],
      getGuildChannels: async () => channels,
      getGuild: async () => guild,
      getGuildMember: async () => ({ user: { id: '20000' }, roles: [] }),
      getChannel: async ({ channelId }) => channels.find((c) => c.id === channelId),
      createMessage: async ({ channelId, retry }) => {
        assert.equal(retry, false);
        effects++;
        return { id: '50000', channel_id: channelId, author: { id: '20000', bot: true } };
      },
    },
  };
  return {
    checked,
    channels,
    guild,
    effects: () => effects,
    stop: () => {
      live = false;
    },
  };
}

test('Discord lists and posts with send/view permission without requiring message history', async () => {
  const f = fixture();
  const reachable = createDiscordReachable();
  const page = await reachable.list(f.checked);
  assert.equal(page.conversations.length, 2);
  assert.deepEqual(await reachable.post(f.checked, '40000', 'first', { beforeSend: () => true }), {
    sent: true,
    receipt: { version: 1, messageId: '50000', conversationId: '40000' },
  });
  assert.equal(f.effects(), 1);
});

test('Discord fresh member/role overwrites and timeout deny before any create', async () => {
  const f = fixture();
  const reachable = createDiscordReachable();
  await reachable.list(f.checked);
  f.channels[0].permission_overwrites = [
    { id: '20000', type: 1, allow: '0', deny: String(1n << 11n) },
  ];
  await assert.rejects(reachable.post(f.checked, '40000', 'never', { beforeSend: () => true }), {
    code: 'send-permission-denied',
  });
  assert.equal((await reachable.list(f.checked)).conversations.length, 1);
  f.checked.api.getGuildMember = async () => ({
    user: { id: '20000' },
    roles: [],
    communication_disabled_until: '2999-01-01T00:00:00Z',
  });
  await assert.rejects(reachable.post(f.checked, '40001', 'never', { beforeSend: () => true }), {
    code: 'send-permission-denied',
  });
  assert.equal(f.effects(), 0);
});

test('Discord pages more than one hundred channels and rejects tampered/other Runtime cursors', async () => {
  const f = fixture(105);
  const reachable = createDiscordReachable();
  const first = await reachable.list(f.checked);
  assert.equal(first.conversations.length, 100);
  assert.equal(first.hasMore, true);
  const next = await reachable.list(f.checked, { cursor: first.cursor });
  assert.equal(next.conversations.length, 5);
  assert.equal(next.hasMore, false);
  await assert.rejects(reachable.list(f.checked, { cursor: first.cursor + 'x' }), {
    code: 'bad-request',
  });
  await assert.rejects(createDiscordReachable().list(f.checked, { cursor: first.cursor }), {
    code: 'bad-request',
  });
});

test('Discord final caller/lifetime fences suppress effects; mismatched native receipts remain unknown', async () => {
  const f = fixture();
  const reachable = createDiscordReachable();
  await assert.rejects(reachable.post(f.checked, '40000', 'never', { beforeSend: () => false }), {
    code: 'send-permission-denied',
  });
  await assert.rejects(
    reachable.post(f.checked, '40000', 'never', {
      beforeSend: () => {
        f.stop();
        return true;
      },
    }),
    { code: 'capability-unavailable' },
  );
  assert.equal(f.effects(), 0);
  const g = fixture();
  let effects = 0;
  g.checked.api.createMessage = async () => {
    effects++;
    return { id: '50000', channel_id: '49999', author: { id: '20000', bot: true } };
  };
  await assert.rejects(reachable.post(g.checked, '40000', 'first', { beforeSend: () => true }), {
    code: 'send-result-unknown',
  });
  assert.equal(effects, 1);
});
