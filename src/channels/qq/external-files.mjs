import { isQqAddressedMessage, isQqDirectMessage } from './external-addressing.mjs';
import { QQ_EXTERNAL_IMAGE_LIMIT } from './external-images.mjs';
import { qqNativeIdentifier } from './native-reply-observations.mjs';
import { qqAttachmentLabel, qqReadableAttachments, qqSkippedAttachmentNotes } from './external-attachments.mjs';

// Same rendering as the SDK contentSanitizer applies to the top-level body.
function qqFaceText(text) {
  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (tag, ext) => {
    try { return `【表情: ${JSON.parse(Buffer.from(ext, 'base64').toString('utf-8')).text || '未知表情'}】`; }
    catch { return tag; }
  });
}

const refusal = (code, reason) => Object.assign(new Error(code), { code, ...(reason ? { reason } : {}) });

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
/** Verified single quoted element of a native quote; throws a visible refusal otherwise. */
function qqQuotedElement(message, { ordinary = false } = {}) {
  const raw = message.raw;
  const elements = raw?.msg_elements;
  const element = Array.isArray(elements) && elements.length === 1 ? elements[0] : undefined;
  const key = element?.msg_idx;
  const refs = Array.isArray(raw?.message_scene?.ext)
    ? raw.message_scene.ext.filter(value => typeof value === 'string' && value.split('=', 1)[0].trim() === 'ref_msg_idx')
      .map(value => value.slice(value.indexOf('=') + 1).trim()) : [];
  if (!(ordinary ? message?.kind === 'group' && message.rawEventType === 'GROUP_MESSAGE_CREATE'
    : isQqAddressedMessage(message))
    || raw?.message_type !== 103 || raw.id !== message.messageId || raw.group_openid !== message.groupOpenid
    || (isQqDirectMessage(message) ? raw.author?.user_openid : raw.author?.member_openid) !== message.senderId
    || raw.author?.bot === true)
    throw refusal('invalid-inbound', 'quote-envelope-invalid');
  if (!qqNativeIdentifier(key) || message.refMsgIdx !== key || refs.some(value => value !== key))
    throw refusal('invalid-inbound', 'quote-reference-invalid');
  if ((message.attachments !== undefined && (!Array.isArray(message.attachments) || message.attachments.length))
    || (raw.attachments !== undefined && (!Array.isArray(raw.attachments) || raw.attachments.length))
    || !Array.isArray(message.msgElements) || message.msgElements.length !== 1
    || message.msgElements[0]?.msg_idx !== key
    || (message.msgElements[0]?.attachments?.length ?? 0) !== (element.attachments?.length ?? 0)
    || Object.keys(element).some(field => !['msg_idx', 'content', 'message_type', 'attachments'].includes(field))
    || (element.message_type !== undefined && (!Number.isSafeInteger(element.message_type)
      || element.message_type < 0))
    || (element.attachments !== undefined && !Array.isArray(element.attachments))
    || (element.content !== undefined && typeof element.content !== 'string')
    || typeof message.content !== 'string')
    throw refusal('invalid-inbound', 'quote-elements-invalid');
  return { key, element };
}

/** Shared native quote authority; each media owner supplies its own category policy. */
export function qqQuotedMediaMessage(message, { accepts, label, requireCaption = true }) {
  if (message?.msgType !== 103) return undefined;
  const { key, element } = qqQuotedElement(message);
  if (!element.attachments?.length || !accepts(element.attachments)
    || (requireCaption && !message.content.trim()))
    throw refusal('invalid-inbound', 'quote-elements-invalid');
  return { referenceKey: key, message: { ...message, msgType: 0, msgElements: undefined,
    content: `${message.content}\n[Quoted ${label}]`, attachments: element.attachments } };
}

/**
 * A quote keeps its quoted text and every quoted attachment: readable ones are
 * attached under the quote's reference, the rest are named in the text.
 * Ordinary (unaddressed) quotes are admitted as text only.
 */
export function qqQuotedMessage(message, { sourceImages = false, sourceFiles = false, ordinary = false } = {}) {
  if (message?.msgType !== 103) return undefined;
  const { key, element } = qqQuotedElement(message, { ordinary });
  const { readable, skipped } = qqReadableAttachments(element.attachments,
    ordinary ? {} : { sourceImages, sourceFiles });
  // The SDK sanitizer only rewrites the top-level body, so quoted QQ faces are rendered here.
  const quoted = qqFaceText(element.content ?? '').trim();
  const caption = message.content.trim();
  const lines = ['[Quoted message]', ...(quoted ? [quoted] : []),
    ...readable.map(file => `[Quoted ${qqAttachmentLabel(file)}]`),
    ...qqSkippedAttachmentNotes(skipped, { quoted: true })];
  const content = `${caption ? `${caption}\n\n` : ''}${lines.join('\n')}`;
  if (content.length > 16000) throw refusal('invalid-inbound', 'quote-elements-invalid');
  return { ...(readable.length ? { referenceKey: key } : {}),
    message: { ...message, msgType: 0, msgElements: undefined, content,
      attachments: readable.length ? readable : undefined } };
}
