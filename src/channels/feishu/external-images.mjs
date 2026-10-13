import { createHash } from 'node:crypto';

const failure = () => Object.assign(new Error('invalid-inbound'), { code: 'invalid-inbound' });
const key = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

// Native image keys are private resource selectors, not browser URLs.
export function nativeImageContent(message, conversationId) {
  const type = message.message_type ?? message.msg_type;
  if (!['image', 'post'].includes(type)) return undefined;
  let value;
  try { value = JSON.parse(message.content ?? message.body?.content); } catch { throw failure(); }
  const messageId = message.message_id;
  if (!key(messageId) || !key(conversationId)) throw failure();
  const attachments = [];
  const contentParts = [];
  const text = value => {
    if (typeof value !== 'string') throw failure();
    if (value) contentParts.push({ kind: 'text', text: value });
  };
  const image = resourceKey => {
    if (!key(resourceKey)) throw failure();
    const id = createHash('sha256').update(JSON.stringify([conversationId, messageId, resourceKey])).digest('hex');
    if (attachments.some(item => item.id === id)) { contentParts.push({ kind: 'attachment', id }); return; }
    if (attachments.length >= 32) throw failure();
    attachments.push({ id, messageId, resourceKey, name: 'image', mediaType: 'image/unknown' });
    contentParts.push({ kind: 'attachment', id });
  };
  if (type === 'image') image(value?.image_key);
  else {
    // The get-message API returns one resolved post; receive events may carry locales.
    const post = Array.isArray(value?.content) ? value : Object.values(value ?? {}).find(item => Array.isArray(item?.content));
    if (!post || post.content.length > 128) throw failure();
    if (post.title !== undefined && post.title !== '') { text(post.title); text('\n'); }
    for (let rowIndex = 0; rowIndex < post.content.length; rowIndex++) {
      const row = post.content[rowIndex];
      if (!Array.isArray(row) || row.length > 128) throw failure();
      for (const item of row) {
        if (item?.tag === 'img') image(item.image_key);
        else if (['text', 'a'].includes(item?.tag)) text(item.text ?? '');
        else if (item?.tag === 'at') { const label = item.user_name || item.user_id; if (!key(label)) throw failure(); text('@' + label); }
        else throw failure(); // A narrow image slice must not silently drop other native content.
      }
      if (rowIndex < post.content.length - 1) text('\n');
    }
    if (!attachments.length) return undefined;
  }
  const plainText = contentParts.filter(item => item.kind === 'text').map(item => item.text).join('');
  if (plainText.length > 16000 || contentParts.length > 256) throw failure();
  return { text: plainText.trim() ? plainText : '[Image]', attachments, contentParts };
}
