import { qqQuotedMediaMessage } from './external-files.mjs';

const refusal = code => Object.assign(new Error(code), { code });

/** ASR provenance comes exclusively from the native voice attachment, never its caption. */
const isVoice = native => native?.content_type === 'voice' || /^audio\/[a-z0-9!#$&^_.+-]+$/i.test(native?.content_type ?? '');

export function qqVoiceMessage(message) {
  const candidate = message?.msgType === 103 ? message.raw?.msg_elements?.[0]?.attachments?.[0] : message?.attachments?.[0];
  if (!isVoice(candidate)) return undefined;
  const quoted = message?.msgType === 103 ? qqQuotedMediaMessage(message, {
    accepts: files => files.length === 1 && isVoice(files[0]), label: 'voice',
  }) : undefined;
  message = quoted?.message ?? message;
  const attachments = message?.attachments;
  if (!Array.isArray(attachments) || attachments.length !== 1) return undefined;
  const native = attachments[0];
  if (!isVoice(native)) return undefined;
  if (native.asr_refer_text !== undefined && (typeof native.asr_refer_text !== 'string' || native.asr_refer_text.length > 12000))
    throw refusal('invalid-inbound');
  if (typeof message.content !== 'string') throw refusal('invalid-inbound');
  const transcript = native.asr_refer_text?.trim();
  const caption = typeof message.content === 'string' ? message.content.trim() : '';
  const body = transcript || '[QQ voice message: platform did not provide a transcript]';
  const text = caption ? `${caption}\n[QQ voice]\n${body}` : body;
  if (text.length > 16000) throw refusal('invalid-inbound');
  return { nativeMessage: { ...message, content: text }, referenceKey: quoted?.referenceKey,
    voice: { transcript: transcript ? 'platform' : 'unavailable' },
    message: { ...message, attachments: undefined, content: text } };
}
