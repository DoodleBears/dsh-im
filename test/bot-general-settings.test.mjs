import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { BotGeneralSettingsPage } from '../plugin-src/client/bot-general-settings.js';
import { en, setImTranslator } from '../plugin-src/client/i18n.js';
const { act, create } = TestRenderer;
const result = (botId, busyMessageMode) => ({ ok: true, value: { bots: [{ botId, busyMessageMode }] } });
const text = (node) => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
async function mount(t, rpcCall) {
  let view;
  await act(async () => { view = create(React.createElement(BotGeneralSettingsPage, {
    key: 'one', account: { botId: 'one' }, rpcCall,
  })); });
  t.after(async () => { await act(async () => view.unmount()); });
  return view;
}

test('general settings reads the bot mode, saves only the selected enum, and keeps failed saves retryable', async (t) => {
  const calls = [];
  let fail = true;
  const view = await mount(t, async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'connection.status') return result('one', undefined);
    if (fail) return { ok: false, error: { message: 'disk full' } };
    return result('one', payload.busyMessageMode);
  });
  const select = () => view.root.findByType('select');
  const save = () => view.root.findByType('button');
  assert.equal(select().props.value, 'queue');
  assert.deepEqual(select().findAllByType('option').map((node) => node.props.value), ['queue', 'steer']);
  assert.equal(save().props.disabled, true);
  await act(async () => select().props.onChange({ target: { value: 'steer' } }));
  await act(async () => save().props.onClick());
  assert.match(text(view.root.findByProps({ role: 'alert' })), /disk full/);
  assert.equal(save().props.disabled, false);
  fail = false;
  await act(async () => save().props.onClick());
  assert.deepEqual(calls.at(-1), { endpoint: 'bot.message-mode.set', payload: { botId: 'one', busyMessageMode: 'steer' } });
  assert.equal(save().props.disabled, true);
  assert.match(text(view.root.findByProps({ role: 'status' })), /已保存/);
});

test('failed initial load cannot overwrite server settings and can be retried', async (t) => {
  let fail = true;
  const view = await mount(t, async () => {
    if (fail) throw new Error('offline');
    return result('one', 'steer');
  });
  assert.equal(view.root.findByType('select').props.disabled, true);
  fail = false;
  await act(async () => view.root.findAllByType('button').find((button) => text(button) === '重新读取').props.onClick());
  assert.equal(view.root.findByType('select').props.value, 'steer');
  assert.equal(view.root.findByType('select').props.disabled, false);
});

test('switching bot discards the old pending response; labels translate to English', async (t) => {
  setImTranslator((source) => en[source] ?? source);
  t.after(() => setImTranslator(null));
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const view = await mount(t, () => pending);
  await act(async () => view.update(React.createElement(BotGeneralSettingsPage, {
    key: 'two', account: { botId: 'two' }, rpcCall: async () => result('two', 'steer'),
  })));
  await act(async () => resolve(result('one', 'queue')));
  assert.equal(view.root.findByType('select').props.value, 'steer');
  assert.equal(text(view.root.findByType('h2')), 'General');
  assert.equal(text(view.root.findByType('button')), 'Save');
});
