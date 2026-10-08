import { ApiError, messagePath } from '@tencent-connect/qqbot-nodejs/protocol';
import { qqNativeIdentifier } from './native-reply-observations.mjs';
import { qqRefusal } from './external-consumer.mjs';

function nativePostFailure(error) {
  if (!(error instanceof ApiError)) return qqRefusal('send-result-unknown');
  const code = Number(error.bizCode);
  if (error.httpStatus === 429 || code === 40034100) return qqRefusal('send-rate-limited');
  if ([40034101, 40034105, 40054002, 40054003, 40054016].includes(code))
    return qqRefusal('send-permission-denied');
  if ([22006, 304061, 40034006, 40054007, 40054010].includes(code)) return qqRefusal('bad-request');
  return qqRefusal('send-result-unknown');
}

export async function postQqText({ bot, target, text, signal, beforeSend, verifyAccount, assertCurrent }) {
  const groupId = target?.route?.groupOpenId;
  if (target?.kind !== 'group' || !qqNativeIdentifier(groupId)) throw qqRefusal('invalid-target');
  if (typeof text !== 'string' || !text.trim() || text.length > 4000
    || typeof beforeSend !== 'function' || typeof verifyAccount !== 'function') throw qqRefusal('bad-request');
  const fence = () => {
    if (signal?.aborted) throw qqRefusal('cancelled');
    assertCurrent();
    if (beforeSend() !== true) throw qqRefusal('send-permission-denied');
    if (signal?.aborted) throw qqRefusal('cancelled');
  };
  fence();
  let token;
  try { token = await bot.api.getToken(); }
  catch { throw qqRefusal(signal?.aborted ? 'cancelled' : 'provider-unavailable'); }
  await verifyAccount();
  fence();
  let response;
  try {
    response = await bot.apiClient.request(token, 'POST', messagePath('group', groupId),
      { msg_type: 0, content: text });
  } catch (error) { throw nativePostFailure(error); }
  if (signal?.aborted || !qqNativeIdentifier(response?.id)) throw qqRefusal('send-result-unknown');
  return { sent: true, receipt: { version: 1, messageId: response.id, conversationId: groupId } };
}
