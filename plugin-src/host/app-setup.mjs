import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { registerManagementRpc } from '../management-rpc.mjs';

const ENDPOINT = 'dsh-im/app-setup';
const TTL = 10 * 60_000;
const failure = (code) => Object.assign(new Error(code), { code });

/** Provider-owned setup sessions. Credentials never cross the same-Host Service. */
export class AppSetupService {
  #channels = new Map();
  #attempts = new Map();
  #describeBot;
  #logger;

  constructor({ describeBot, logger }) {
    this.#describeBot = describeBot;
    this.#logger = logger;
  }

  #record(phase, channel, startedAt, reason) {
    try {
      this.#logger?.info?.(JSON.stringify({ event: 'im-app-setup', initiator: 'client',
        ...(['feishu', 'weixin'].includes(channel) ? { channel } : {}), phase,
        durationMs: Math.max(0, Date.now() - startedAt), ...(reason ? { reason } : {}) }));
    } catch {}
  }

  register(channel, controller) {
    if (!['feishu', 'weixin'].includes(channel)) return () => {};
    const previous = this.#channels.get(channel);
    if (previous) this.#retire(channel, previous);
    const registration = { controller };
    this.#channels.set(channel, registration);
    return () => this.#retire(channel, registration);
  }

  #retire(channel, registration) {
    if (this.#channels.get(channel) === registration) this.#channels.delete(channel);
    for (const attempt of this.#attempts.values()) {
      if (attempt.registration !== registration || attempt.controller.signal.aborted) continue;
      attempt.controller.abort();
      void this.#stopQr(attempt).catch(() => undefined);
      this.#record('disposed', channel, attempt.startedAt);
    }
  }

  describe(channel) {
    return this.#channels.has(channel)
      ? { version: 1, channel, endpoint: ENDPOINT, kind: channel === 'weixin' ? 'qr' : 'credentials' }
      : undefined;
  }

  async call(method, payload, signal) {
    const startedAt = Date.now();
    try { return await this.#call(method, payload, signal); }
    catch (error) {
      const reason = ['bad-request', 'capability-unavailable', 'setup-expired', 'setup-limit', 'setup-account-exists'].includes(error?.code)
        ? error.code : signal?.aborted || this.#attempts.get(payload?.attemptId)?.controller.signal.aborted
          ? 'cancelled' : 'setup-failed';
      this.#record('refused', this.#attempts.get(payload?.attemptId)?.channel, startedAt, reason);
      throw error;
    }
  }

  async #call(method, payload, signal) {
    signal?.throwIfAborted();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('bad-request');
    if (method === 'setup.start') {
      if (Object.keys(payload).some((key) => key !== 'channel')) throw failure('bad-request');
      const registration = this.#channels.get(payload.channel);
      if (!registration) throw failure('capability-unavailable');
      for (const [id, attempt] of this.#attempts) {
        if (attempt.expiresAt <= Date.now()) {
          attempt.controller.abort();
          await this.#stopQr(attempt);
          this.#attempts.delete(id);
          this.#record('expired', attempt.channel, attempt.startedAt);
        }
      }
      if (this.#attempts.size >= 32) throw failure('setup-limit');
      const attempt = { attemptId: randomUUID(), channel: payload.channel, registration, controller: new AbortController(),
        state: 'credentials', startedAt: Date.now(), expiresAt: Date.now() + TTL };
      this.#attempts.set(attempt.attemptId, attempt);
      this.#record('started', attempt.channel, attempt.startedAt);
      if (attempt.channel === 'weixin') {
        attempt.state = 'creating';
        this.#armExpiry(attempt);
        attempt.operation = this.#beginQr(attempt);
        try { return await attempt.operation; }
        finally { delete attempt.operation; }
      }
      return this.#view(attempt);
    }
    const attempt = this.#attempts.get(payload.attemptId);
    if (!attempt) throw failure('setup-expired');
    if (attempt.expiresAt <= Date.now()) {
      attempt.controller.abort();
      await this.#stopQr(attempt);
      this.#attempts.delete(attempt.attemptId);
      this.#record('expired', attempt.channel, attempt.startedAt);
      throw failure('setup-expired');
    }
    if (this.#channels.get(attempt.channel) !== attempt.registration) throw failure('capability-unavailable');
    if (['setup.poll', 'setup.cancel'].includes(method)
      && Object.keys(payload).some((key) => key !== 'attemptId')) throw failure('bad-request');
    if (method === 'setup.poll') {
      if (attempt.channel === 'weixin' && attempt.state !== 'ready') await this.#pollQr(attempt);
      if (attempt.accountRef && !attempt.description) await this.#describe(attempt);
      return this.#view(attempt);
    }
    if (method === 'setup.cancel') {
      attempt.controller.abort();
      await this.#stopQr(attempt);
      await attempt.operation?.catch(() => undefined);
      if (attempt.channel === 'weixin' && attempt.qrAttemptId) await this.#pollQr(attempt);
      if (attempt.state !== 'ready') attempt.state = 'cancelled';
      this.#record(attempt.state === 'ready' ? 'retained' : 'cancelled', attempt.channel, attempt.startedAt);
      return this.#view(attempt);
    }
    if (method === 'setup.verify' && attempt.channel === 'weixin') {
      if (attempt.state !== 'needs_verification'
        || Object.keys(payload).some(key => !['attemptId', 'verifyCode'].includes(key))
        || typeof payload.verifyCode !== 'string' || !/^\d{4,8}$/.test(payload.verifyCode)) throw failure('bad-request');
      await attempt.registration.controller.submitVerification(attempt.qrAttemptId, payload.verifyCode);
      await this.#pollQr(attempt);
      return this.#view(attempt);
    }
    if (attempt.channel !== 'feishu' || method !== 'setup.credentials' || attempt.state !== 'credentials'
      || Object.keys(payload).some((key) => !['attemptId', 'appId', 'appSecret', 'domain'].includes(key))
      || typeof payload.appId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/.test(payload.appId)
      || typeof payload.appSecret !== 'string' || !payload.appSecret.trim() || payload.appSecret.length > 4096
      || !['lark', 'feishu'].includes(payload.domain)) throw failure('bad-request');
    attempt.state = 'creating';
    this.#record('creating', attempt.channel, attempt.startedAt);
    attempt.operation = this.#create(attempt, payload);
    try { return await attempt.operation; }
    finally { delete attempt.operation; }
  }

  async #beginQr(attempt) {
    try {
      const begun = await attempt.registration.controller.startProvisioning({
        consumerMode: 'external-consumer', signal: attempt.controller.signal,
      });
      attempt.qrAttemptId = begun.attemptId;
      attempt.expiresAt = Math.min(attempt.expiresAt, begun.expiresAt);
      this.#armExpiry(attempt);
      if (attempt.controller.signal.aborted) { await this.#stopQr(attempt); throw failure('setup-failed'); }
      if (begun.verificationUrl) attempt.qrDataUrl = await QRCode.toDataURL(begun.verificationUrl, {
        type: 'image/png', errorCorrectionLevel: 'M', margin: 2, width: 320,
      });
      attempt.controller.signal.throwIfAborted();
      if (this.#channels.get(attempt.channel) !== attempt.registration) throw failure('capability-unavailable');
      await this.#pollQr(attempt);
      return this.#view(attempt);
    } catch {
      attempt.controller.abort();
      await this.#stopQr(attempt);
      if (attempt.state !== 'expired') attempt.state = 'failed';
      throw failure('setup-failed');
    }
  }

  async #stopQr(attempt) {
    clearTimeout(attempt.expiryTimer);
    if (attempt.qrAttemptId) await attempt.registration.controller.cancelProvisioning(attempt.qrAttemptId);
    delete attempt.qrDataUrl;
  }

  #armExpiry(attempt) {
    clearTimeout(attempt.expiryTimer);
    attempt.expiryTimer = setTimeout(() => {
      if (attempt.state === 'ready') return;
      attempt.state = 'expired';
      attempt.controller.abort();
      void this.#stopQr(attempt).catch(() => undefined);
      this.#record('expired', attempt.channel, attempt.startedAt);
    }, Math.max(0, attempt.expiresAt - Date.now()));
    attempt.expiryTimer.unref?.();
  }

  async #pollQr(attempt) {
    const status = attempt.registration.controller.registrationStatus(attempt.qrAttemptId);
    if (!status) throw failure('setup-expired');
    if (status.status === 'connected') {
      if (!status.botId) throw failure('setup-failed');
      attempt.accountRef = status.botId;
      await this.#describe(attempt);
      delete attempt.qrDataUrl;
    } else if (['pending', 'scanned', 'needs_verification', 'connecting', 'expired', 'cancelled', 'failed'].includes(status.status)) {
      attempt.state = status.status;
      if (['expired', 'cancelled', 'failed'].includes(attempt.state)) delete attempt.qrDataUrl;
    } else throw failure('setup-failed');
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
    clearTimeout(attempt.expiryTimer);
    this.#record('ready', attempt.channel, attempt.startedAt);
  }

  #view(attempt) {
    return { version: 1, attemptId: attempt.attemptId, channel: attempt.channel,
      state: attempt.state, expiresAt: attempt.expiresAt,
      ...(attempt.qrDataUrl ? { qrDataUrl: attempt.qrDataUrl } : {}),
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
