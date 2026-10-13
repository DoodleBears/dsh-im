import { qqNativeIdentifier } from './native-reply-observations.mjs';

function displayName(value) {
  return typeof value === 'string' && value.trim() && value.length <= 512
    && !/[\u0000-\u001f]/u.test(value) ? value.trim() : undefined;
}

export function qqExternalMentions(message, account) {
  if (!Array.isArray(message.mentions) || message.mentions.length > 100) return [];
  const entries = new Map();
  const ambiguous = new Set();
  for (const mention of message.mentions) {
    if (!mention || typeof mention !== 'object' || mention.scope === 'all') continue;
    const ids = [...new Set([mention.id, mention.user_openid, mention.member_openid]
      .filter(qqNativeIdentifier))];
    if (ids.length !== 1) continue;
    const id = ids[0];
    const name = displayName(mention.username) ?? displayName(mention.nickname)
      ?? (mention.is_you === true ? displayName(account.name) : undefined);
    for (const key of [`<@${id}>`, `<@!${id}>`]) {
      if (key.length > 512) continue;
      if (!message.content.includes(key) || ambiguous.has(key)) continue;
      const prior = entries.get(key);
      if (prior && (prior.id !== id || prior.name !== name)) {
        entries.delete(key); ambiguous.add(key); continue;
      }
      entries.set(key, Object.freeze({ id, key, ...(name ? { name } : {}) }));
      if (entries.size > 100) return [];
    }
  }
  return Object.freeze([...entries.values()]);
}
