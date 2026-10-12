// Proposed public constructor option, compiled into the hash-checked SDK 1.0.4.
// These values are the pinned SDK's protocol constants, never caller-supplied labels.
export const qqObservedOpcodes = Object.freeze([0, 1, 2, 6, 7, 9, 10, 11]);
export const qqObservedEventTypes = Object.freeze(['READY', 'RESUMED', 'GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE',
  'C2C_MESSAGE_CREATE', 'AT_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE', 'INTERACTION_CREATE', 'other']);

export function frameBytes(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
    const total = data.reduce((size, chunk) => size + chunk.byteLength, 0);
    return Number.isSafeInteger(total) ? total : null;
  }
  return null;
}

export function frameEnvelope(op, type, sequence) {
  return { opcode: qqObservedOpcodes.includes(op) ? op : 'other',
    eventType: qqObservedEventTypes.includes(type) ? type : 'other',
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null };
}

export function observeFrame(observer, value) {
  if (typeof observer !== 'function') return false;
  try {
    const result = observer(Object.freeze(value));
    if (result && typeof result.then === 'function') void Promise.resolve(result).catch(() => {});
    return true;
  } catch { return false; }
}
