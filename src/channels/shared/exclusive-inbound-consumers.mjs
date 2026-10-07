function refusal(code) {
  return Object.assign(new Error(code), { code });
}

export class ExclusiveInboundConsumers {
  #entries = new Map();

  acceptsFiles(botId) { return this.#entries.get(botId)?.sourceFiles === true; }
  acceptsImages(botId) { return this.#entries.get(botId)?.sourceImages === true; }
  acceptsVoiceTranscripts(botId) { return this.#entries.get(botId)?.sourceVoiceTranscripts === true; }
  acceptsQuotes(botId) { return this.#entries.get(botId)?.sourceQuotes === true; }
  acceptsVideos(botId) { return this.#entries.get(botId)?.sourceVideos === true; }
  acceptsVoiceAudio(botId) { return this.#entries.get(botId)?.sourceVoiceAudio === true; }
  acceptsOrdinary(botId) { return this.#entries.get(botId)?.ordinaryText === true; }

  register(botId, { fingerprint, onEvent, signal, sourceFiles = false, sourceImages = false, sourceVoiceTranscripts = false, sourceVoiceAudio = false, sourceVideos = false, sourceQuotes = false, ordinaryText = false, onEcho, onAction }) {
    if (this.#entries.has(botId)) throw refusal('consumer-conflict');
    if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '') || typeof onEvent !== 'function' || typeof sourceFiles !== 'boolean' || typeof sourceImages !== 'boolean' || typeof sourceVoiceTranscripts !== 'boolean' || typeof sourceVoiceAudio !== 'boolean' || typeof sourceVideos !== 'boolean' || typeof sourceQuotes !== 'boolean' || typeof ordinaryText !== 'boolean' || (onEcho !== undefined && typeof onEcho !== 'function') || (onAction !== undefined && typeof onAction !== 'function'))
      throw refusal('bad-request');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const entry = { fingerprint, onEvent, onEcho, onAction, sourceFiles, sourceImages, sourceVoiceTranscripts, sourceVoiceAudio, sourceVideos, sourceQuotes, ordinaryText, controller, dispose: undefined };
    const dispose = () => {
      if (this.#entries.get(botId) === entry) this.#entries.delete(botId);
      controller.abort(refusal('consumer-unavailable'));
      signal?.removeEventListener('abort', dispose);
    };
    entry.dispose = dispose;
    this.#entries.set(botId, entry);
    signal?.addEventListener('abort', dispose, { once: true });
    return dispose;
  }

  async accept(botId, evidence, signal, echo = false) {
    const entry = this.#entries.get(botId);
    if (!entry) throw refusal('consumer-unavailable');
    if (entry.fingerprint !== evidence.fingerprint) throw refusal('account-changed');
    const deliverySignal = signal
      ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal;
    deliverySignal.throwIfAborted();
    const callback = echo ? entry.onEcho : entry.onEvent;
    if (callback === undefined) return { accepted: true, ignored: true };
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(deliverySignal.reason);
      deliverySignal.addEventListener('abort', abort, { once: true });
      if (deliverySignal.aborted) abort();
    });
    let result;
    try {
      result = await Promise.race([callback(evidence, { signal: deliverySignal }), interrupted]);
    } finally {
      deliverySignal.removeEventListener('abort', abort);
    }
    deliverySignal.throwIfAborted();
    if (this.#entries.get(botId) !== entry) throw refusal('consumer-unavailable');
    if (result?.accepted !== true) throw refusal('ingress-not-accepted');
    return { accepted: true };
  }

  async acceptAction(botId, evidence, signal) {
    const entry = this.#entries.get(botId);
    if (!entry || typeof entry.onAction !== 'function') throw refusal('consumer-unavailable');
    const current = signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal;
    current.throwIfAborted();
    if (entry.fingerprint !== evidence.fingerprint) throw refusal('account-changed');
    const result = await entry.onAction(evidence, { signal: current });
    current.throwIfAborted();
    if (this.#entries.get(botId) !== entry) throw refusal('consumer-unavailable');
    if (result?.accepted !== true || !['queued', 'refused'].includes(result.status)) throw refusal('ingress-not-accepted');
    return { toast: { type: result.status === 'queued' ? 'info' : 'error', content: result.status === 'queued'
      ? 'Received; checking authority. / 已收到，正在核验权限。'
      : 'Not authorized or request expired. / 未获授权或请求已失效。' } };
  }

  signalFor(botId, fingerprint) {
    const entry = this.#entries.get(botId);
    if (!entry) throw refusal('consumer-unavailable');
    if (entry.fingerprint !== fingerprint) throw refusal('account-changed');
    return entry.controller.signal;
  }

  remove(botId) {
    const entry = this.#entries.get(botId);
    entry?.dispose();
  }

  close() {
    for (const botId of this.#entries.keys()) this.remove(botId);
  }
}
