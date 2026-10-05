import { detectedImageMediaType } from '../shared/image-prompt.mjs';
import { weixinRefusal } from './external-consumer.mjs';

export const WEIXIN_EXTERNAL_FILE_LIMIT = 25 * 1024 * 1024;

/** A source-scoped file ticket is private state, not a model-readable download URL. */
export function privateWeixinFile(message, event) {
  if (!event.attachments?.length) return undefined;
  const native = message.item_list.find(item => item.type === 4 || item.type === 2);
  const image = native?.type === 2;
  const file = image ? native.image_item : native?.file_item;
  const media = file?.media;
  if (!media || typeof media !== 'object'
    || (!(image && typeof file.aeskey === 'string' && /^[a-fA-F0-9]{32}$/.test(file.aeskey))
      && (typeof media.aes_key !== 'string' || !media.aes_key || media.aes_key.length > 128))
    || ![media.encrypt_query_param, media.full_url].some(value => typeof value === 'string' && value.length > 0 && value.length <= 16384))
    throw weixinRefusal('resource-unavailable');
  return { attachment: event.attachments[0], ...(image ? { kind: 'image' } : {}), item: {
    ...(image ? (typeof file.aeskey === 'string' ? { aeskey: file.aeskey } : {}) : { file_name: file.file_name }),
    ...(file.len === undefined ? {} : { len: String(file.len) }),
    media: { aes_key: media.aes_key, encrypt_type: media.encrypt_type,
      ...(typeof media.encrypt_query_param === 'string' && media.encrypt_query_param.length <= 16384
        ? { encrypt_query_param: media.encrypt_query_param } : {}),
      ...(typeof media.full_url === 'string' && media.full_url.length <= 16384
        ? { full_url: media.full_url } : {}) } } };
}

export async function readWeixinExternalFile(api, source, attachment, { signal, assertCurrent }) {
  assertCurrent();
  const saved = source.file;
  if (!saved || !attachment || Object.keys(attachment).some(key => !['id', 'messageId', 'resourceKey', 'name', 'sizeBytes', 'mediaType'].includes(key))
    || ['id', 'messageId', 'resourceKey', 'name', 'sizeBytes', 'mediaType'].some(key => attachment[key] !== saved.attachment[key]))
    throw weixinRefusal('stale-route');
  if (attachment.sizeBytes > WEIXIN_EXTERNAL_FILE_LIMIT) throw weixinRefusal('artifact-too-large');
  const image = saved.kind === 'image';
  const file = image
    ? api.inboundImages({ item_list: [{ type: 2, image_item: saved.item }] })[0]
    : api.inboundFiles({ item_list: [{ type: 4, file_item: saved.item }] })[0];
  if (!file) throw weixinRefusal('resource-unavailable');
  const data = await file.load({ signal, maxBytes: WEIXIN_EXTERNAL_FILE_LIMIT });
  assertCurrent();
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw weixinRefusal('resource-unavailable');
  if (data.byteLength > WEIXIN_EXTERNAL_FILE_LIMIT) throw weixinRefusal('artifact-too-large');
  if (image && !detectedImageMediaType(data)) throw weixinRefusal('resource-unavailable');
  if (saved.item.len !== undefined && data.byteLength !== Number(saved.item.len)) throw weixinRefusal('resource-unavailable');
  return (async function* () { assertCurrent(); yield new Uint8Array(data); assertCurrent(); })();
}

export async function replyWeixinExternalFile(api, request, file, { signal, assertCurrent }) {
  if (typeof file?.id !== 'string' || !file.id || file.id.length > 512
    || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 512
    || /[\x00-\x1f\x7f/\\]/.test(file.name) || !(file.bytes instanceof Uint8Array)
    || !file.bytes.byteLength || file.bytes.byteLength > WEIXIN_EXTERNAL_FILE_LIMIT) throw weixinRefusal('bad-request');
  assertCurrent();
  try {
    const image = typeof file.mediaType === 'string' && file.mediaType.startsWith('image/');
    if (image && file.mediaType !== detectedImageMediaType(file.bytes)) throw weixinRefusal('bad-request');
    const send = image ? api.sendImage : api.sendFile;
    if (typeof send !== 'function') throw weixinRefusal('capability-unavailable');
    const result = await send({ ...request, signal,
      file: { artifactId: file.id, fileName: file.name, bytes: Buffer.from(file.bytes) },
      beforeSend: assertCurrent });
    assertCurrent();
    if (typeof result?.messageId !== 'string' || !result.messageId.startsWith('dsh-weixin-'))
      throw weixinRefusal('provider-result-unknown');
    return { sent: true };
  } catch (error) {
    if (error?.code === 'artifact-provider-failed') throw weixinRefusal('file-upload-failed');
    if (['artifact-permission-required', 'artifact-too-large', 'artifact-provider-rejected', 'artifact-rate-limited'].includes(error?.code))
      throw weixinRefusal('file-provider-rejected');
    throw error;
  }
}
