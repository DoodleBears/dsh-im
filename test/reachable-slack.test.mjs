import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listSlackReachable,
  postSlackConversation,
} from '../src/channels/slack/reachable-conversations.mjs';

function fixture() {
  let live = true;
  let effects = 0;
  const channels = new Map([
    ['COPEN1', { id: 'COPEN1', name: 'open', is_channel: true, is_member: true }],
    [
      'GPRIV1',
      { id: 'GPRIV1', name: 'private', is_group: true, is_private: true, is_member: true },
    ],
    ['CGONE1', { id: 'CGONE1', is_channel: true, is_member: false }],
    ['CARCH1', { id: 'CARCH1', is_channel: true, is_member: true, is_archived: true }],
    [
      'CREST1',
      {
        id: 'CREST1',
        is_channel: true,
        is_member: true,
        properties: { posting_restricted_to: { user: ['UOTHER'] } },
      },
    ],
  ]);
  const checked = {
    account: { userId: 'UOWN01', teamId: 'TOWN01', botId: 'BOWN01', appId: 'AOWN01' },
    signal: new AbortController().signal,
    assertCurrent() {
      if (!live) throw Object.assign(new Error('stopped'), { code: 'capability-unavailable' });
    },
    api: {
      postingScopes: () => new Set(['chat:write', 'channels:read', 'groups:read']),
      userConversations: async ({ cursor }) =>
        cursor === undefined
          ? {
              channels: [...channels.keys()].map((id) => ({ id })),
              response_metadata: { next_cursor: 'next' },
            }
          : { channels: [], response_metadata: { next_cursor: '' } },
      conversationInfo: async ({ channelId }) => channels.get(channelId),
      postMessage: async ({ channelId, retry }) => {
        assert.equal(retry, false);
        effects++;
        return {
          channel: channelId,
          ts: '1791870000.123456',
          message: { user: 'UOWN01', bot_id: 'BOWN01', app_id: 'AOWN01' },
        };
      },
    },
  };
  return {
    checked,
    channels,
    effects: () => effects,
    stop: () => {
      live = false;
    },
  };
}

test('Slack discovers joined public/private channels, excludes archived and restricted destinations, and pages', async () => {
  const f = fixture();
  assert.deepEqual(await listSlackReachable(f.checked), {
    version: 1,
    conversations: [
      { id: 'COPEN1', kind: 'group', name: 'open' },
      { id: 'GPRIV1', kind: 'group', name: 'private' },
    ],
    hasMore: true,
    cursor: 'next',
  });
  assert.equal((await listSlackReachable(f.checked, { cursor: 'next' })).hasMore, false);
});

test('Slack rechecks current membership/scope before sending and preserves one exact receipt', async () => {
  const f = fixture();
  await listSlackReachable(f.checked);
  f.channels.get('COPEN1').is_member = false;
  await assert.rejects(
    postSlackConversation(f.checked, 'COPEN1', 'never', { beforeSend: () => true }),
    { code: 'send-permission-denied' },
  );
  assert.equal(f.effects(), 0);
  const sent = await postSlackConversation(f.checked, 'GPRIV1', 'first', {
    beforeSend: () => true,
  });
  assert.deepEqual(sent, {
    sent: true,
    receipt: { version: 1, messageId: '1791870000.123456', conversationId: 'GPRIV1' },
  });
  assert.equal(f.effects(), 1);
});

test('Slack final caller/runtime fences and missing chat scope refuse without an effect', async () => {
  const f = fixture();
  await assert.rejects(
    postSlackConversation(f.checked, 'COPEN1', 'never', { beforeSend: () => false }),
    { code: 'send-permission-denied' },
  );
  await assert.rejects(
    postSlackConversation(f.checked, 'COPEN1', 'never', {
      beforeSend: () => {
        f.stop();
        return true;
      },
    }),
    { code: 'capability-unavailable' },
  );
  assert.equal(f.effects(), 0);
  const g = fixture();
  g.checked.api.postingScopes = () => new Set(['channels:read']);
  await assert.rejects(
    postSlackConversation(g.checked, 'COPEN1', 'never', { beforeSend: () => true }),
    { code: 'send-permission-denied' },
  );
  assert.equal(g.effects(), 0);
});

test('Slack mismatched receipt and interrupted native effect stay unknown and are never retried', async () => {
  const f = fixture();
  let effects = 0;
  f.checked.api.postMessage = async () => {
    effects++;
    return { channel: 'COTHER', ts: '1791870000.123456' };
  };
  await assert.rejects(
    postSlackConversation(f.checked, 'COPEN1', 'first', { beforeSend: () => true }),
    { code: 'send-result-unknown' },
  );
  assert.equal(effects, 1);
  f.checked.api.postMessage = async () => {
    effects++;
    throw new Error('connection lost');
  };
  await assert.rejects(
    postSlackConversation(f.checked, 'COPEN1', 'second', { beforeSend: () => true }),
    { code: 'send-result-unknown' },
  );
  assert.equal(effects, 2);
});
