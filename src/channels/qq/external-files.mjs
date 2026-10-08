import { QQ_EXTERNAL_IMAGE_LIMIT } from './external-images.mjs';

const refusal = code => Object.assign(new Error(code), { code });

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
