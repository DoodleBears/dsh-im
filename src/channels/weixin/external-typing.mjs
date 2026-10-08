import { weixinRefusal } from './external-consumer.mjs';

export class CheckedWeixinTyping {
  #api;
  #connection;
  #logger;
  #intervalMs;
  #maximumMs;
  #active = null;
  #status = { phase: 'idle' };

  constructor({ api, baseUrl, token, logger = console, intervalMs = 5_000, maximumMs = 600_000 }) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > 10_000
      || !Number.isFinite(maximumMs) || maximumMs <= 0 || maximumMs > 600_000)
      throw new TypeError('Invalid typing lifecycle bounds');
    this.#api = api;
    this.#connection = { baseUrl, token };
    this.#logger = logger;
    this.#intervalMs = intervalMs;
    this.#maximumMs = maximumMs;
  }

  get status() { return { ...this.#status }; }

  async start({ toUserId, contextToken, signal, validate, onState }) {
    if (typeof validate !== 'function' || !signal || signal.aborted)
      throw weixinRefusal('cancelled');
    if (typeof this.#api.getConfig !== 'function' || typeof this.#api.sendTyping !== 'function')
      throw weixinRefusal('typing-unavailable');
    if (this.#active) throw weixinRefusal('typing-conflict');
    const entry = { closed: false, controller: new AbortController(), ticket: null,
      attempted: false, timer: null, deadline: null, tail: Promise.resolve(), done: null,
      startedAt: Date.now() };
    this.#active = entry;
    const notify = (phase, reason) => {
      this.#status = { phase, ...(reason ? { reason } : {}) };
      const state = { ...this.#status };
      try { onState?.(state); } catch {}
      try { this.#logger.warn?.(JSON.stringify({ event: 'weixin-typing', phase,
        initiator: 'external-consumer', durationMs: Date.now() - entry.startedAt,
        ...(reason ? { reason } : {}) })); } catch {}
    };
    const operationSignal = () => AbortSignal.any([
      signal, entry.controller.signal, AbortSignal.timeout(5_000),
    ]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      entry.controller.signal.throwIfAborted();
      if (entry.closed || validate() !== true) throw weixinRefusal('stale-route');
    };
    const stop = (reason = 'completed') => {
      if (entry.done) return entry.done;
      entry.closed = true;
      entry.controller.abort();
      clearTimeout(entry.timer);
      clearTimeout(entry.deadline);
      signal.removeEventListener('abort', aborted);
      entry.done = (async () => {
        await entry.tail.catch(() => undefined);
        let phase = 'idle';
        if (entry.ticket && entry.attempted) {
          try {
            await this.#api.sendTyping({ ...this.#connection, toUserId,
              typingTicket: entry.ticket, status: 2, signal: AbortSignal.timeout(3_000) });
          } catch { phase = 'cleanup-unconfirmed'; }
        }
        if (this.#active === entry) this.#active = null;
        notify(phase, reason);
      })();
      return entry.done;
    };
    const aborted = () => { void stop('cancelled'); };
    entry.stop = stop;
    signal.addEventListener('abort', aborted, { once: true });
    const schedule = () => {
      if (entry.closed) return;
      entry.timer = setTimeout(() => {
        entry.tail = entry.tail.then(async () => {
          assertCurrent();
          await this.#api.sendTyping({ ...this.#connection, toUserId,
            typingTicket: entry.ticket, status: 1, signal: operationSignal() });
          assertCurrent();
          notify('accepted');
          schedule();
        });
        void entry.tail.catch(() => { void stop('renewal-refused'); });
      }, this.#intervalMs);
      entry.timer.unref?.();
    };
    entry.tail = Promise.resolve().then(async () => {
      assertCurrent();
      notify('requesting');
      const config = await this.#api.getConfig({ ...this.#connection,
        toUserId, contextToken, signal: operationSignal() });
      assertCurrent();
      if (typeof config?.typingTicket !== 'string' || !config.typingTicket.trim())
        throw weixinRefusal('typing-unavailable');
      entry.ticket = config.typingTicket;
      entry.attempted = true;
      await this.#api.sendTyping({ ...this.#connection, toUserId,
        typingTicket: entry.ticket, status: 1, signal: operationSignal() });
      assertCurrent();
      notify('accepted');
      schedule();
    });
    entry.deadline = setTimeout(() => { void stop('maximum-duration'); }, this.#maximumMs);
    entry.deadline.unref?.();
    try {
      await entry.tail;
      assertCurrent();
      return { accepted: true, stop: () => stop('completed') };
    } catch (error) {
      await stop(signal.aborted ? 'cancelled' : 'typing-unavailable');
      throw weixinRefusal(signal.aborted ? 'cancelled'
        : error?.code === 'stale-route' ? 'stale-route' : 'typing-unavailable');
    }
  }

  async close() { await this.#active?.stop('disposed'); }
}
