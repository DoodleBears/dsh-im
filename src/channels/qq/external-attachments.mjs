import { isQqVoiceAttachment } from './voice-attachment.mjs';

export const QQ_READABLE_IMAGE_TYPES = Object.freeze(new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']));
const IMAGE_ALIASES = Object.freeze({ 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png' });
const IMAGE_EXTENSIONS = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' });
const LABELS = Object.freeze({ image: 'image', file: 'file', voice: 'voice message', video: 'video', other: 'attachment' });

function contentType(native) {
  return typeof native?.content_type === 'string' ? native.content_type.split(';', 1)[0].trim().toLowerCase() : '';
}

/** QQ labels images loosely, so the declared type, its common aliases and the file name all count. */
export function qqImageMediaType(native) {
  const type = contentType(native);
  const declared = IMAGE_ALIASES[type] ?? type;
  if (QQ_READABLE_IMAGE_TYPES.has(declared)) return declared;
  if (type && type !== 'image' && type !== 'application/octet-stream') return undefined;
  const extension = typeof native?.filename === 'string' ? /\.([a-z0-9]{1,8})$/i.exec(native.filename)?.[1] : undefined;
  return extension ? IMAGE_EXTENSIONS[extension.toLowerCase()] : undefined;
}

export function qqAttachmentCategory(native) {
  if (isQqVoiceAttachment(native)) return 'voice';
  if (qqImageMediaType(native)) return 'image';
  const type = contentType(native);
  if (type === 'file') return 'file';
  if (type === 'video' || type.startsWith('video/')) return 'video';
  if (type === 'image' || type.startsWith('image/')) return 'image-unsupported';
  return 'other';
}

/** QQ sometimes omits the scheme or sends plain HTTP for its own media hosts. */
export function qqAttachmentUrl(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^http:\/\//i.test(value)) return `https://${value.slice(7)}`;
  return value;
}

/** Splits native attachments into what this consumer can read and what it can only mention. */
export function qqReadableAttachments(attachments, { sourceImages = false, sourceFiles = false } = {}) {
  const readable = [];
  const skipped = [];
  for (const native of Array.isArray(attachments) ? attachments : []) {
    const category = qqAttachmentCategory(native);
    if ((category === 'image' && sourceImages) || (category === 'file' && sourceFiles))
      readable.push({ ...native, url: qqAttachmentUrl(native.url) });
    else skipped.push(category);
  }
  return { readable, skipped };
}

export function qqAttachmentLabel(native) {
  return LABELS[qqAttachmentCategory(native)] ?? LABELS.other;
}

export function qqSkippedAttachmentNotes(skipped, { quoted = false } = {}) {
  return skipped.map(category => {
    const label = category === 'image-unsupported' ? 'image in an unsupported format' : LABELS[category] ?? LABELS.other;
    return quoted ? `[Quoted ${label} not readable by the Bot]`
      : `[${label[0].toUpperCase()}${label.slice(1)} not readable by the Bot]`;
  });
}
