import { randomUUID } from 'node:crypto';
import { registerManagementRpc } from '../management-rpc.mjs';

const ENDPOINT = 'dsh-im/app-setup';
const TTL = 10 * 60_000;
const failure = (code) => Object.assign(new Error(code), { code });

/** Provider-owned setup sessions. Credentials never cross the same-Host Service. */
export class AppSetupService {
  #channels = new Map();
  #attempts = new Map();
  #describeBot;

  constructor({ describeBot }) { this.#describeBot = describeBot; }

  register(channel, controller) {
    if (channel !== 'feishu') return () => {};
    const registration = { controller };
    this.#channels.set(channel, registration);
    return () => {
      if (this.#channels.get(channel) !== registration) return;
      this.#channels.delete(channel);
      for (const attempt of this.#attempts.values()) {
        if (attempt.registration === registration) attempt.controller.abort();
      }
    };
  }

  describe(channel) {
    return this.#channels.has(channel)
      ? { version: 1, channel, endpoint: ENDPOINT, kind: 'credentials' }
      : undefined;
  }

  async call(method, payload, signal) {
    signal?.throwIfAborted();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('bad-request');
    if (method === 'setup.start') {
      if (Object.keys(payload).some((key) => key !== 'channel')) throw failure('bad-request');
      const registration = this.#channels.get(payload.channel);
      if (!registration) throw failure('capability-unavailable');
      for (const [id, attempt] of this.#attempts) {
        if (attempt.expiresAt <= Date.now()) this.#attempts.delete(id);
      }
      if (this.#attempts.size >= 32) throw failure('setup-limit');
      const attempt = { attemptId: randomUUID(), channel: payload.channel, registration, controller: new AbortController(),
        state: 'credentials', expiresAt: Date.now() + TTL };
      this.#attempts.set(attempt.attemptId, attempt);
      return this.#view(attempt);
    }
    const attempt = this.#attempts.get(payload.attemptId);
    if (!attempt || attempt.expiresAt <= Date.now()) throw failure('setup-expired');
    if (this.#channels.get(attempt.channel) !== attempt.registration) throw failure('capability-unavailable');
    if (['setup.poll', 'setup.cancel'].includes(method)
      && Object.keys(payload).some((key) => key !== 'attemptId')) throw failure('bad-request');
    if (method === 'setup.poll') {
      if (attempt.accountRef && !attempt.description) await this.#describe(attempt);
      return this.#view(attempt);
    }
    if (method === 'setup.cancel') {
      attempt.controller.abort();
      await attempt.operation?.catch(() => undefined);
      if (attempt.state !== 'ready') attempt.state = 'cancelled';
      return this.#view(attempt);
    }
    if (method !== 'setup.credentials' || attempt.state !== 'credentials'
      || Object.keys(payload).some((key) => !['attemptId', 'appId', 'appSecret', 'domain'].includes(key))
      || typeof payload.appId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/.test(payload.appId)
      || typeof payload.appSecret !== 'string' || !payload.appSecret.trim() || payload.appSecret.length > 4096
      || !['lark', 'feishu'].includes(payload.domain)) throw failure('bad-request');
    attempt.state = 'creating';
    attempt.operation = this.#create(attempt, payload);
    try { return await attempt.operation; }
    finally { delete attempt.operation; }
  }

  async #create(attempt, payload) {
    try {
      const created = await attempt.registration.controller.bindCredentials({
        appId: payload.appId, appSecret: payload.appSecret, domain: payload.domain,
        consumerMode: 'external-consumer',
        signal: attempt.controller.signal,
      });
      if (!created.accountRef) throw failure('account-unverified');
      attempt.accountRef = created.accountRef;
      await this.#describe(attempt);
      return this.#view(attempt);
    } catch (error) {
      attempt.state = attempt.controller.signal.aborted ? 'cancelled' : attempt.accountRef ? 'creating' : 'credentials';
      throw failure(error?.code === 'setup-account-exists' ? error.code : 'setup-failed');
    }
  }

  async #describe(attempt) {
    if (this.#channels.get(attempt.channel) !== attempt.registration) throw failure('capability-unavailable');
    const description = await this.#describeBot(attempt.accountRef);
    if (this.#channels.get(attempt.channel) !== attempt.registration) throw failure('capability-unavailable');
    attempt.description = { version: description.version, channel: description.channel,
      botId: description.botId, account: { fingerprint: description.account.fingerprint,
        ...(description.account.name ? { name: description.account.name } : {}) },
      connected: description.connected, capabilities: [...description.capabilities] };
    attempt.state = 'ready';
  }

  #view(attempt) {
    return { version: 1, attemptId: attempt.attemptId, channel: attempt.channel,
      state: attempt.state, expiresAt: attempt.expiresAt,
      ...(attempt.accountRef ? { accountRef: attempt.accountRef, description: attempt.description } : {}) };
  }
}

export function installAppSetupRpc(ctx, setup, authority) {
  return registerManagementRpc(ctx, '/app-setup', async (method, payload, signal) => {
    try { return { ok: true, value: await setup.call(method, payload, signal) }; }
    catch (error) {
      const code = ['bad-request', 'capability-unavailable', 'setup-expired', 'setup-limit', 'setup-account-exists'].includes(error?.code)
        ? error.code : 'setup-failed';
      return { ok: false, error: { code, message: code, details: {} } };
    }
  }, { authority });
}
