import { randomUUID } from 'node:crypto';

const peers = new WeakMap();

/**
 * DSH 0.2.1 Gateways require every in-process caller to name the Peer it
 * speaks for. dsh-im runs inside the Host on behalf of its local owner, so
 * every dsh-im caller under one Host root shares one owner Peer. Gateways
 * before 0.2.1 ignore the field.
 */
export function hostOwnerPeer(ctx) {
  const scope = ctx?.root ?? ctx;
  const current = peers.get(scope);
  if (current && !current.signal.aborted) return current;
  const controller = new AbortController();
  const peer = Object.freeze({
    id: `dsh-im:${randomUUID()}`,
    ctx,
    principal: Object.freeze({ kind: 'owner' }),
    signal: controller.signal,
    interactions: 'none',
    async dispose() {
      controller.abort();
      if (peers.get(scope) === peer) peers.delete(scope);
    },
  });
  peers.set(scope, peer);
  return peer;
}
