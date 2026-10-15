import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionController } from '../../../plugin-src/host/channels/qq/production.mjs';
import { QqConfigStore, deriveQqBotIdentity } from '../../../src/channels/qq/config-store.mjs';
import { QqRuntime } from '../../../src/channels/qq/qq-runtime.mjs';
import { createDeliveryService } from '../../../plugin-src/host/delivery-service.mjs';

test('QQ production carries ordinary-text opt-in into its actual Runtime', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-qq-production-ordinary-'));
  let production;
  t.after(async () => { await production?.close(); await rm(dataDir, { recursive: true, force: true }); });
  const identity = deriveQqBotIdentity('12345678');
  const store = await new QqConfigStore(join(dataDir, 'config.json')).load();
  await store.save({ ...identity, appId: '12345678', ownerUserOpenid: 'owner', consumerMode: 'external-consumer' });
  let bot;
  class PlatformBot extends EventEmitter {
    api = { get: async () => ({ id: 'native-bot-id', bot: true }) };
    use() {}
    async start(signal) {
      queueMicrotask(() => this.emit('ready', {}));
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    }
    stop() {}
    async deliver(message) { await Promise.all(this.listeners('message').map(listener => listener({}, message))); }
  }
  class Runtime extends QqRuntime {
    constructor(options) {
      super({ ...options, typingMiddleware: () => () => {}, connectTimeoutMs: 100,
        createBot: () => { bot = new PlatformBot(); return bot; } });
    }
  }
  class Harness { stopManagedProcess() {} }
  production = await createProductionController({
    credentials: { resolve: async () => ({ value: 'test-secret' }), set: async () => {}, unset: async () => {} },
    apiProxy: {}, logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  }, { dataDir }, {
    HarnessClient: Harness, Runtime,
    createConnectionSupervisor: () => ({ ready: Promise.resolve(), start() { return this; }, async close() {} }),
  });
  await production.controller.initialize();
  const service = createDeliveryService();
  service.registerAdapter(production.deliveryAdapter);
  const account = await service.describeBot(identity.botId);
  const admitted = [];
  await service.consumeInbound(identity.botId, {
    expectedFingerprint: account.account.fingerprint, ordinaryText: true,
    onEvent: async event => { admitted.push(event); return { accepted: true }; },
  });
  await bot.deliver({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', msgType: 0,
    messageId: 'production-ordinary-source', senderId: 'app-scoped-member', groupOpenid: 'app-scoped-group',
    content: 'The group chose the blue plan.', timestamp: new Date().toISOString(),
    replyTarget: { scope: 'group', targetId: 'app-scoped-group', msgId: 'production-ordinary-source' } });
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].mentionedAccount, false);
  assert.equal(admitted[0].text, 'The group chose the blue plan.');
});

test('QQ production has no per-bot result-file Gate', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-qq-production-artifacts-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const runtimes = [];
  let controllerOptions;

  class ConfigStore {
    async load() { return this; }
    list() { return []; }
  }
  class StateStore {
    async load() { return this; }
  }
  class Harness {
    stopManagedProcess() {}
  }
  class Runtime {
    constructor(options) {
      this.options = options;
      runtimes.push(options);
    }
  }
  class Controller {
    constructor(options) {
      controllerOptions = options;
    }
    async close() {}
  }
  class QrAuth {}
  const supervisor = {
    ready: Promise.resolve(),
    start() { return this; },
    async close() {},
  };

  const production = await createProductionController({
    credentials: {},
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  }, { dataDir }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    QrAuth,
    createConnectionSupervisor: () => supervisor,
  });

  await controllerOptions.createRuntime({
    botId: 'qq_enabled',
    config: { botId: 'qq_enabled', appId: 'app-enabled' },
    appSecret: 'host-only',
  });
  await controllerOptions.createRuntime({
    botId: 'qq_disabled',
    config: { botId: 'qq_disabled', appId: 'app-disabled' },
    appSecret: 'host-only',
  });

  assert.equal(Object.hasOwn(runtimes[0], 'outboundArtifactsEnabled'), false);
  assert.equal(Object.hasOwn(runtimes[1], 'outboundArtifactsEnabled'), false);
  await production.close();
});
