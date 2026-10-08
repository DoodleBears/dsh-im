import { qualifyExternalReply } from './reply-context.mjs';

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const emojiTypes = Object.freeze({ received: 'GLANCE', answered: 'DONE' });

// Never retry a possibly accepted platform write. The consumer owns durable
// attempt deduplication; this operation only validates the source and writes.
export async function reactExternalMessage(client, identity, route, reaction,
  { signal, assertCurrent, beforeSend } = {}) {
  if (!Object.hasOwn(emojiTypes, reaction) || typeof beforeSend !== 'function') refuse('bad-request');
  assertCurrent();
  const qualified = await qualifyExternalReply(client, route, signal);
  if (qualified.actorId !== route.actorId) refuse('stale-route');
  assertCurrent();
  if (beforeSend() !== true) refuse('stale-route');
  signal?.throwIfAborted();
  const result = await client.im.v1.messageReaction.create({
    path: { message_id: route.messageId },
    data: { reaction_type: { emoji_type: emojiTypes[reaction] } },
  }, { signal });
  if ([99991672, 99991679, 231002, 231008, 231018, 231019, 231020, 231021, 231022].includes(result?.code))
    refuse('reaction-permission-denied');
  if (typeof result?.code !== 'number' || result.code === 231015) refuse('reaction-result-unknown');
  if (result.code !== 0) refuse('reaction-provider-rejected');
  if (typeof result.data?.reaction_id !== 'string' || !result.data.reaction_id ||
    result.data.operator?.operator_type !== 'app' || result.data.operator.operator_id !== identity.appId ||
    result.data.reaction_type?.emoji_type !== emojiTypes[reaction]) refuse('reaction-result-unknown');
  return { accepted: true };
}
