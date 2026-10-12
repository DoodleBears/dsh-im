import { observeFrame, qqObservedOpcodes, qqObservedEventTypes } from './sdk-frame-observation.mjs';

const phases = ['received', 'decoded', 'parse-refused', 'processing-refused'];

/** Bounded process evidence for the maintained SDK option; never delivery authority. */
export class QqNativeTransportDiagnostics {
  #fingerprint;
  #report;
  #windowAt = 0;
  #reported = 0;
  #suppressed = 0;
  #context;
  constructor({ account, report }) { this.#fingerprint = account.fingerprint; this.#report = report; }
  get context() { return this.#context && { ...this.#context }; }
  observe(value, signal) {
    if (signal?.aborted || !value || !phases.includes(value.phase)
      || !Number.isSafeInteger(value.connection) || value.connection < 1
      || !Number.isSafeInteger(value.frame) || value.frame < 1
      || !(value.bytes === null || Number.isSafeInteger(value.bytes) && value.bytes >= 0)) return;
    const context = { connection: value.connection, frame: value.frame };
    this.#context = value.phase === 'decoded' ? context : undefined;
    const now = Date.now();
    if (now - this.#windowAt >= 60_000) { this.#windowAt = now; this.#reported = 0; }
    if (this.#reported >= 128) { this.#suppressed++; return; }
    this.#reported++;
    const record = { event: 'qq.native-transport.frame', accountFingerprint: this.#fingerprint,
      ...context, phase: value.phase, bytes: value.bytes, suppressed: this.#suppressed };
    if (value.phase === 'decoded') {
      record.opcode = qqObservedOpcodes.includes(value.opcode) ? value.opcode : 'other';
      record.eventType = qqObservedEventTypes.includes(value.eventType) ? value.eventType : 'other';
      record.sequence = Number.isSafeInteger(value.sequence) && value.sequence >= 0 ? value.sequence : null;
    }
    if (observeFrame(this.#report, record)) this.#suppressed = 0;
  }
}
