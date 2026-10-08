import { fetchImageBuffer } from '../shared/image-prompt.mjs';
import { QQ_IMAGE_HOSTS } from './qq-bridge.mjs';
import { QQ_EXTERNAL_IMAGE_LIMIT } from './external-images.mjs';

const refusal = code => Object.assign(new Error(code), { code });

/** The shared bounded HTTP transport does not decode images. Private tickets stay here. */
export async function readQqSourceFile(source, attachment, { signal, assertCurrent, verifyAccount }) {
  assertCurrent();
  const file = source.files?.find(file => file.attachment.id === attachment?.id);
  if (!file || Object.keys(attachment).some(key => !Object.hasOwn(file.attachment, key))
    || Object.keys(file.attachment).some(key => file.attachment[key] !== attachment[key]))
    throw refusal('stale-route');
  let bytes;
  try {
    bytes = await fetchImageBuffer(file.url, { signal, allowedHosts: QQ_IMAGE_HOSTS,
      maxBytes: QQ_EXTERNAL_IMAGE_LIMIT, timeoutMs: 15000 });
  } catch (error) {
    assertCurrent();
    throw refusal(error?.code === 'image-too-large' ? 'artifact-too-large' : 'resource-unavailable');
  }
  assertCurrent();
  await verifyAccount();
  assertCurrent();
  if (attachment.sizeBytes !== undefined && bytes.byteLength !== attachment.sizeBytes)
    throw refusal('resource-unavailable');
  return (async function* () {
    await verifyAccount();
    assertCurrent();
    yield new Uint8Array(bytes);
    assertCurrent();
  })();
}

export function checkedQqGenericFile(file) {
  if (typeof file?.id !== 'string' || !file.id || file.id.length > 512
    || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 512
    || /[\x00-\x1f\x7f/\\]/.test(file.name) || !(file.bytes instanceof Uint8Array)
    || !file.bytes.byteLength || typeof file.mediaType !== 'string'
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mediaType)
    || /^(image|audio|video)\//i.test(file.mediaType)) throw refusal('bad-request');
  if (file.bytes.byteLength > QQ_EXTERNAL_IMAGE_LIMIT) throw refusal('artifact-too-large');
  return Buffer.from(file.bytes);
}
