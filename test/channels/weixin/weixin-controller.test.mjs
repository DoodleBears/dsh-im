import assert from 'node:assert/strict';
import test from 'node:test';

import { WeixinController } from '../../../src/channels/weixin/weixin-controller.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('inline WeChat setup pairs through Provider transport and starts only an external consumer', async () => {
  const { AppSetupService, installAppSetupRpc } = await import('../../../plugin-src/host/app-setup.mjs');
  const { managementFetch } = await import('../../fixtures/management-rpc.mjs');
  const credentials = credentialsFixture();
  const configs = configFixture();
  const runtimes = runtimeFactory();
  let confirm;
  const scanned = new Promise(resolve => { confirm = resolve; });
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'private-qr-token', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/inline' }),
      pollLogin: async () => scanned,
    }, credentials: credentials.provider, configStore: configs.store, createRuntime: runtimes.createRuntime,
  });
  const logs = [];
  const setup = new AppSetupService({ describeBot: id => controller.describeDeliveryAccount(id),
    logger: { info: entry => logs.push(entry) } });
  setup.register('weixin', controller);
  let rpc;
  installAppSetupRpc({ connection: { fetch: managementFetch((_channel, handler) => { rpc = handler; }) } }, setup);
  try {
    assert.deepEqual(setup.describe('weixin'), { version: 1, channel: 'weixin', endpoint: 'dsh-im/app-setup', kind: 'qr' });
    const started = await rpc('setup.start', { channel: 'weixin' });
    assert.equal(started.ok, true);
    assert.equal(started.value.state, 'pending');
    assert.match(started.value.qrDataUrl, /^data:image\/png;base64,/);
    assert.equal(started.value.accountRef, undefined);
    confirm({ status: 'confirmed', bot_token: 'private-paired-token', ilink_bot_id: 'inline@im.bot',
      ilink_user_id: 'paired-owner', baseurl: 'https://ilinkai.weixin.qq.com' });
    const ready = await waitFor(() => controller.status(), value => value.totals.connected === 1);
    const result = await rpc('setup.poll', { attemptId: started.value.attemptId });
    assert.equal(result.value.state, 'ready');
    assert.equal(result.value.accountRef, ready.bots[0].botId);
    assert.match(result.value.description.account.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(runtimes.runtimes.length, 1);
    assert.equal(runtimes.runtimes[0].config.consumerMode, 'external-consumer');
    assert.equal([...configs.accounts.values()][0].consumerMode, 'external-consumer');
    assert.doesNotMatch(JSON.stringify({ result, logs }), /private-paired-token|private-qr-token|verificationUrl|tokenRef/);
    assert.equal(result.value.qrDataUrl, undefined);
    assert.equal((await rpc('setup.cancel', { attemptId: started.value.attemptId })).value.state, 'ready');
    assert.equal(controller.status().totals.connected, 1);
  } finally { confirm({ status: 'expired' }); await controller.close(); }
});

async function waitFor(read, predicate, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = read();
    if (predicate(value)) return value;
    await flush();
  }
  throw new Error('condition was not reached');
}

test('cancelling a completed QR before the next poll retains its authenticated account', async () => {
  const { AppSetupService } = await import('../../../plugin-src/host/app-setup.mjs');
  const configs = configFixture();
  let confirm;
  const scan = new Promise(resolve => { confirm = resolve; });
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'secret-qr', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/retain' }),
      pollLogin: async () => scan,
    }, credentials: credentialsFixture().provider, configStore: configs.store, createRuntime: runtimeFactory().createRuntime,
  });
  const setup = new AppSetupService({ describeBot: id => controller.describeDeliveryAccount(id) });
  setup.register('weixin', controller);
  try {
    const begun = await setup.call('setup.start', { channel: 'weixin' });
    assert.equal(begun.state, 'pending');
    confirm({ status: 'confirmed', bot_token: 'retained-token', ilink_bot_id: 'retained@im.bot', ilink_user_id: 'owner' });
    await waitFor(() => controller.status(), value => value.totals.connected === 1);
    const cancelled = await setup.call('setup.cancel', { attemptId: begun.attemptId });
    assert.equal(cancelled.state, 'ready');
    assert.equal(cancelled.accountRef, controller.status().bots[0].botId);
    assert.equal(cancelled.qrDataUrl, undefined);
  } finally { confirm({ status: 'expired' }); await controller.close(); }
});

function credentialsFixture() {
  const values = new Map();
  const calls = [];
  return {
    values,
    calls,
    provider: {
      resolve: async (ref) => values.has(ref)
        ? { configured: true, source: 'settings', value: values.get(ref) }
        : { configured: false },
      set: async (ref, value) => { calls.push(['set', ref]); values.set(ref, value); },
      unset: async (ref) => { calls.push(['unset', ref]); values.delete(ref); },
    },
  };
}

test('an abandoned inline QR expires while waiting for a pairing code and stops the Provider attempt', async (t) => {
  const { AppSetupService } = await import('../../../plugin-src/host/app-setup.mjs');
  const credentials = credentialsFixture();
  const configs = configFixture();
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'private-expiry-qr', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/expiry' }),
      pollLogin: async () => ({ status: 'need_verifycode' }),
    }, credentials: credentials.provider, configStore: configs.store, createRuntime: runtimeFactory().createRuntime,
  });
  const setup = new AppSetupService({ describeBot: id => controller.describeDeliveryAccount(id) });
  setup.register('weixin', controller);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    const begun = await setup.call('setup.start', { channel: 'weixin' });
    assert.equal(begun.state, 'needs_verification');
    t.mock.timers.tick(5 * 60_000 + 1);
    await flush();
    assert.equal(controller.status().state, 'disconnected');
    await assert.rejects(setup.call('setup.poll', { attemptId: begun.attemptId }), { code: 'setup-expired' });
    assert.equal(credentials.values.size, 0);
    assert.equal(configs.accounts.size, 0);
  } finally { t.mock.timers.reset(); await controller.close(); }
});

function configFixture() {
  const accounts = new Map();
  return {
    accounts,
    store: {
      list: () => [...accounts.values()].map((account) => structuredClone(account)),
      get: (botId) => accounts.has(botId) ? structuredClone(accounts.get(botId)) : null,
      getByAccountId: (accountId) => {
        const found = [...accounts.values()].find((account) => account.accountId === accountId);
        return found ? structuredClone(found) : null;
      },
      save: async (account) => { accounts.set(account.botId, structuredClone(account)); return account; },
      remove: async (botId) => accounts.delete(botId),
    },
  };
}

for (const phase of ['verification', 'activation']) test(`cancelling inline WeChat during ${phase} leaves no account or token`, async () => {
  const { AppSetupService } = await import('../../../plugin-src/host/app-setup.mjs');
  const credentials = credentialsFixture();
  const configs = configFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let saveEntered = false;
  if (phase === 'activation') {
    const save = configs.store.save;
    configs.store.save = async account => { await save(account); saveEntered = true; await gate; return account; };
  }
  let confirm;
  const scan = new Promise(resolve => { confirm = resolve; });
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'private-cancel-qr', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/cancel' }),
      pollLogin: async () => phase === 'verification' ? { status: 'need_verifycode' } : scan,
    }, credentials: credentials.provider, configStore: configs.store, createRuntime: runtimeFactory().createRuntime,
    logger: { error() {}, info() {}, warn() {} },
  });
  const setup = new AppSetupService({ describeBot: id => controller.describeDeliveryAccount(id) });
  setup.register('weixin', controller);
  try {
    const begun = await setup.call('setup.start', { channel: 'weixin' });
    if (phase === 'activation') {
      confirm({ status: 'confirmed', bot_token: 'cancelled-token', ilink_bot_id: 'cancelled@im.bot', ilink_user_id: 'owner' });
      await waitFor(() => saveEntered, Boolean);
    }
    const cancelling = setup.call('setup.cancel', { attemptId: begun.attemptId });
    await flush();
    release();
    assert.equal((await cancelling).state, 'cancelled');
    assert.equal((await setup.call('setup.poll', { attemptId: begun.attemptId })).state, 'cancelled');
    assert.equal(credentials.values.size, 0);
    assert.equal(configs.accounts.size, 0);
    assert.equal(controller.status().totals.connected, 0);
  } finally { release(); confirm({ status: 'expired' }); await controller.close(); }
});

test('inline QR verification stays on the Provider transport and a second start cannot cancel it', async () => {
  const { AppSetupService } = await import('../../../plugin-src/host/app-setup.mjs');
  const credentials = credentialsFixture();
  const configs = configFixture();
  let polls = 0;
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'private-verified-qr', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/verify' }),
      pollLogin: async ({ verifyCode }) => {
        if (++polls === 1) return { status: 'need_verifycode' };
        assert.equal(verifyCode, '123456');
        return { status: 'confirmed', bot_token: 'private-verified-token', ilink_bot_id: 'verified@im.bot', ilink_user_id: 'owner' };
      },
    }, credentials: credentials.provider, configStore: configs.store, createRuntime: runtimeFactory().createRuntime,
  });
  const setup = new AppSetupService({ describeBot: id => controller.describeDeliveryAccount(id) });
  setup.register('weixin', controller);
  try {
    const begun = await setup.call('setup.start', { channel: 'weixin' });
    assert.equal(begun.state, 'needs_verification');
    await assert.rejects(setup.call('setup.start', { channel: 'weixin' }), { code: 'setup-failed' });
    assert.equal((await setup.call('setup.poll', { attemptId: begun.attemptId })).state, 'needs_verification');
    await assert.rejects(setup.call('setup.verify', { attemptId: begun.attemptId, verifyCode: 'bad' }), { code: 'bad-request' });
    await setup.call('setup.verify', { attemptId: begun.attemptId, verifyCode: '123456' });
    await waitFor(() => controller.status(), value => value.totals.connected === 1);
    assert.equal((await setup.call('setup.poll', { attemptId: begun.attemptId })).state, 'ready');
  } finally { await controller.close(); }
});

function runtimeFactory({ failStart = false, startError, lastMessageError = null } = {}) {
  const runtimes = [];
  const connectionTests = [];
  const proactiveSends = [];
  const createRuntime = async ({ config, token }) => {
    let ready = false;
    const runtime = {
      config,
      token,
      get status() {
        return {
          ready,
          weixinConnectionState: ready ? 'connected' : 'idle',
          harnessReachable: ready,
          lastCheckedAt: ready ? 100 : null,
          lastMessageError,
        };
      },
      async start() {
        if (startError) throw startError;
        if (failStart) throw new Error('runtime start failed with host-only detail');
        ready = true;
      },
      async stop() { ready = false; },
      async sendConnectionTest(text) { connectionTests.push({ botId: config.botId, text }); },
      async sendProactiveText(target, text, options) {
        proactiveSends.push({ botId: config.botId, target, text, options });
        return { sent: true };
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
  return { runtimes, connectionTests, proactiveSends, createRuntime };
}

test('confirmed QR login stores bot_token only in credentials and starts a redacted account', async () => {
  const credentials = credentialsFixture();
  const configs = configFixture();
  const runtimes = runtimeFactory({
    lastMessageError: {
      code: 'attachment-error',
      reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
      message: '当前模型不支持图片。',
      referenceId: 'MF-WX123456',
      at: 123,
      providerDetail: 'must-not-cross-controller-boundary',
    },
  });
  const controller = new WeixinController({
    api: {
      beginLogin: async ({ localTokens }) => {
        assert.deepEqual(localTokens, []);
        return { qrcode: 'qr-secret', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test' };
      },
      pollLogin: async () => ({
        status: 'confirmed',
        bot_token: 'private-bot-token',
        ilink_bot_id: 'account@im.bot',
        ilink_user_id: 'owner-user',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }),
    },
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimes.createRuntime,
  });

  const begun = await controller.startProvisioning();
  const completed = await waitFor(
    () => controller.registrationStatus(begun.attemptId),
    (value) => value.status === 'connected',
  );

  assert.match(completed.botId, /^wx_[a-f0-9]{24}$/);
  assert.equal(credentials.values.size, 1);
  assert.equal([...credentials.values.values()][0], 'private-bot-token');
  const stored = [...configs.accounts.values()][0];
  assert.equal(stored.ownerUserId, 'owner-user');
  assert.equal('token' in stored, false);
  assert.equal(runtimes.runtimes[0].token, 'private-bot-token');
  const publicJson = JSON.stringify(controller.status());
  assert.doesNotMatch(publicJson, /private-bot-token|owner-user|account@im\.bot|tokenRef/);
  assert.equal(controller.status().totals.connected, 1);
  assert.deepEqual(controller.status().bots[0].lastMessageError, {
    code: 'attachment-error',
    reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
    message: '当前模型不支持图片。',
    referenceId: 'MF-WX123456',
    at: 123,
  });
  assert.doesNotMatch(publicJson, /must-not-cross-controller-boundary/);

  await controller.sendConnectionTest(completed.botId);
  assert.equal(runtimes.connectionTests[0].botId, completed.botId);
  assert.match(runtimes.connectionTests[0].text, /DeepSeek Harness 连接测试成功/);
  assert.match(runtimes.connectionTests[0].text, /微信机器人（accoun••••\.bot）/);
  const target = { kind: 'user', route: { toUserId: 'target-user' } };
  assert.deepEqual(await controller.sendProactiveText(completed.botId, target, '主动投递'), {
    sent: true,
  });
  assert.deepEqual(runtimes.proactiveSends[0], {
    botId: completed.botId,
    target,
    text: '主动投递',
    options: {},
  });

  await controller.deleteBot(completed.botId);
  assert.equal(credentials.values.size, 0);
  assert.equal(configs.accounts.size, 0);
  await controller.close();
});

test('verification-code state pauses polling and resumes with the submitted digits', async () => {
  const credentials = credentialsFixture();
  const configs = configFixture();
  const runtimes = runtimeFactory();
  const verifyCodes = [];
  let polls = 0;
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'qr-secret', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test' }),
      pollLogin: async ({ verifyCode }) => {
        polls += 1;
        verifyCodes.push(verifyCode);
        if (polls === 1) return { status: 'need_verifycode' };
        return {
          status: 'confirmed',
          bot_token: 'token-after-code',
          ilink_bot_id: 'verify@im.bot',
          ilink_user_id: 'verify-owner',
          baseurl: 'https://ilinkai.weixin.qq.com',
        };
      },
    },
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimes.createRuntime,
  });

  const begun = await controller.startProvisioning();
  await waitFor(
    () => controller.registrationStatus(begun.attemptId),
    (value) => value.status === 'needs_verification',
  );
  assert.equal(polls, 1);
  await controller.submitVerification(begun.attemptId, '123456');
  await waitFor(
    () => controller.registrationStatus(begun.attemptId),
    (value) => value.status === 'connected',
  );
  assert.deepEqual(verifyCodes, [null, '123456']);
  await controller.close();
});

test('runtime activation failure is classified and rolls credentials and config back', async () => {
  const credentials = credentialsFixture();
  const configs = configFixture();
  const runtimes = runtimeFactory({ failStart: true });
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'qr-secret', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test' }),
      pollLogin: async () => ({
        status: 'confirmed',
        bot_token: 'must-be-rolled-back',
        ilink_bot_id: 'rollback@im.bot',
        ilink_user_id: 'owner',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }),
    },
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimes.createRuntime,
    logger: { error() {}, warn() {} },
  });
  const begun = await controller.startProvisioning();
  const failed = await waitFor(
    () => controller.registrationStatus(begun.attemptId),
    (value) => value.status === 'failed',
  );

  assert.equal(failed.error.code, 'connection-start-failed');
  assert.match(failed.error.message, /消息连接初始化失败/);
  assert.equal(credentials.values.size, 0);
  assert.equal(configs.accounts.size, 0);
  assert.doesNotMatch(JSON.stringify(failed), /must-be-rolled-back|host-only detail/);
  await controller.close();
});

test('credential write failure is classified and rolls back a post-commit error', async () => {
  const credentials = credentialsFixture();
  const configs = configFixture();
  credentials.provider.set = async (ref, value) => {
    credentials.values.set(ref, value);
    throw new Error('credential backend failed after commit with private detail');
  };
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'qr-secret', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test' }),
      pollLogin: async () => ({
        status: 'confirmed',
        bot_token: 'must-be-rolled-back',
        ilink_bot_id: 'credential-failure@im.bot',
        ilink_user_id: 'owner',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }),
    },
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimeFactory().createRuntime,
    logger: { error() {}, warn() {} },
  });

  const begun = await controller.startProvisioning();
  const failed = await waitFor(
    () => controller.registrationStatus(begun.attemptId),
    (value) => value.status === 'failed',
  );

  assert.equal(failed.error.code, 'credential-save-failed');
  assert.match(failed.error.message, /DSH 凭据存储/);
  assert.equal(credentials.values.size, 0);
  assert.equal(configs.accounts.size, 0);
  assert.doesNotMatch(JSON.stringify(failed), /private detail|must-be-rolled-back/);
  await controller.close();
});

test('credential read failure stops activation before any durable write', async () => {
  const credentials = credentialsFixture();
  const configs = configFixture();
  credentials.provider.resolve = async () => {
    throw new Error('credential read host-only detail');
  };
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'qr-secret', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test' }),
      pollLogin: async () => ({
        status: 'confirmed',
        bot_token: 'must-never-be-written',
        ilink_bot_id: 'credential-read-failure@im.bot',
        ilink_user_id: 'owner',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }),
    },
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimeFactory().createRuntime,
    logger: { error() {}, warn() {} },
  });

  const begun = await controller.startProvisioning();
  const failed = await waitFor(
    () => controller.registrationStatus(begun.attemptId),
    (value) => value.status === 'failed',
  );

  assert.equal(failed.error.code, 'credential-read-failed');
  assert.equal(credentials.calls.length, 0);
  assert.equal(credentials.values.size, 0);
  assert.doesNotMatch(JSON.stringify(failed), /host-only detail|must-never-be-written/);
  await controller.close();
});

test('account config write and runtime preparation failures have distinct safe codes', async () => {
  for (const scenario of [
    {
      expectedCode: 'account-config-save-failed',
      prepare: ({ configs }) => {
        configs.store.save = async (account) => {
          configs.accounts.set(account.botId, structuredClone(account));
          throw new Error('config path host-only detail');
        };
      },
      createRuntime: runtimeFactory().createRuntime,
    },
    {
      expectedCode: 'runtime-prepare-failed',
      prepare: () => {},
      createRuntime: async () => { throw new Error('workspace path host-only detail'); },
    },
  ]) {
    const credentials = credentialsFixture();
    const configs = configFixture();
    scenario.prepare({ credentials, configs });
    const controller = new WeixinController({
      api: {
        beginLogin: async () => ({ qrcode: 'qr-secret', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test' }),
        pollLogin: async () => ({
          status: 'confirmed',
          bot_token: 'must-be-rolled-back',
          ilink_bot_id: `${scenario.expectedCode}@im.bot`,
          ilink_user_id: 'owner',
          baseurl: 'https://ilinkai.weixin.qq.com',
        }),
      },
      credentials: credentials.provider,
      configStore: configs.store,
      createRuntime: scenario.createRuntime,
      logger: { error() {}, warn() {} },
    });

    const begun = await controller.startProvisioning();
    const failed = await waitFor(
      () => controller.registrationStatus(begun.attemptId),
      (value) => value.status === 'failed',
    );

    assert.equal(failed.error.code, scenario.expectedCode);
    assert.equal(credentials.values.size, 0);
    assert.equal(configs.accounts.size, 0);
    assert.doesNotMatch(JSON.stringify(failed), /host-only detail|must-be-rolled-back/);
    await controller.close();
  }
});

test('known runtime activation codes cross the provisioning boundary unchanged', async () => {
  for (const scenario of [
    ['harness-auth-required', /需要身份认证/],
    ['harness-proxy-auth-required', /NO_PROXY/],
    ['harness-loopback-forbidden', /回环地址/],
    ['harness-host-untrusted', /Host 信任检查/],
    ['harness-request-forbidden', /代理或网关配置/],
    ['harness-api-not-found', /找不到 Harness 健康检查接口/],
  ]) {
    const [code, publicMessage] = scenario;
    const credentials = credentialsFixture();
    const configs = configFixture();
    const runtimes = runtimeFactory({
      startError: Object.assign(new Error(`host-only detail for ${code}`), { code }),
    });
    const controller = new WeixinController({
      api: {
        beginLogin: async () => ({ qrcode: 'qr-secret', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test' }),
        pollLogin: async () => ({
          status: 'confirmed',
          bot_token: 'must-be-rolled-back',
          ilink_bot_id: `${code}@im.bot`,
          ilink_user_id: 'owner',
          baseurl: 'https://ilinkai.weixin.qq.com',
        }),
      },
      credentials: credentials.provider,
      configStore: configs.store,
      createRuntime: runtimes.createRuntime,
      logger: { error() {}, warn() {} },
    });

    const begun = await controller.startProvisioning();
    const failed = await waitFor(
      () => controller.registrationStatus(begun.attemptId),
      (value) => value.status === 'failed',
    );

    assert.equal(failed.error.code, code);
    assert.notEqual(failed.error.code, 'harness-unreachable');
    assert.match(failed.error.message, publicMessage);
    assert.doesNotMatch(JSON.stringify(failed), /host-only detail|must-be-rolled-back/);
    await controller.close();
  }
});

test('an unclassified activation error uses the explicit unknown fallback code', async () => {
  const credentials = credentialsFixture();
  const configs = configFixture();
  configs.store.getByAccountId = () => {
    throw new Error('unexpected host-only activation detail');
  };
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'qr-secret', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test' }),
      pollLogin: async () => ({
        status: 'confirmed',
        bot_token: 'must-never-cross-the-browser-boundary',
        ilink_bot_id: 'unknown-failure@im.bot',
        ilink_user_id: 'owner',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }),
    },
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimeFactory().createRuntime,
    logger: { error() {}, warn() {} },
  });

  const begun = await controller.startProvisioning();
  const failed = await waitFor(
    () => controller.registrationStatus(begun.attemptId),
    (value) => value.status === 'failed',
  );

  assert.equal(failed.error.code, 'activation-unknown-failed');
  assert.notEqual(failed.error.code, 'activation-failed');
  assert.match(failed.error.message, /未知错误/);
  assert.doesNotMatch(
    JSON.stringify(failed),
    /unexpected host-only activation detail|must-never-cross-the-browser-boundary/,
  );
  await controller.close();
});

test('cancelling an in-flight QR long poll is terminal and writes no credentials', async () => {
  const credentials = credentialsFixture();
  const configs = configFixture();
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'qr-secret', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test' }),
      pollLogin: async ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    },
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimeFactory().createRuntime,
  });
  const begun = await controller.startProvisioning();
  const cancelled = await controller.cancelProvisioning(begun.attemptId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(credentials.values.size, 0);
  assert.equal(configs.accounts.size, 0);
  await controller.close();
});
