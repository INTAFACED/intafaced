import type { BroadcastStore } from './broadcast-store.js';

/** The key was answered `not_sent` and its money may already be given back: nothing is signed or sent under it. */
export class BroadcastClosedError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`durable broadcast refused for ${idempotencyKey}: the key was answered not_sent and is closed`);
    this.name = 'BroadcastClosedError';
  }
}

/**
 * Class M outbound broadcast with DIRECTION §3.1 durability:
 *
 *   1. claim — exclusivity for the business key
 *   2. sign (mine only)
 *   3. putSigned — persist signed bytes BEFORE any RPC broadcast
 *   4. eth_sendRawTransaction (or resume rebroadcast of the same bytes)
 *   5. put — journal the returned hash before waiting for inclusion
 *
 * A crash between (3) and (5) resumes via claim→`resume` and rebroadcasts the
 * identical signed payload. Rebroadcasting the same RLP is not a second spend.
 */
export async function runDurableBroadcast(opts: {
  readonly store: BroadcastStore;
  readonly idempotencyKey: string;
  /** Produce a signed raw transaction. Called only on a fresh `mine` claim. */
  readonly sign: () => Promise<string>;
  /** Broadcast signed raw bytes; return the tx hash. */
  readonly broadcast: (signedRaw: string) => Promise<string>;
}): Promise<string> {
  const claimed = await opts.store.claim(opts.idempotencyKey);
  if (claimed.kind === 'done') return claimed.txHash;
  if (claimed.kind === 'closed') throw new BroadcastClosedError(opts.idempotencyKey);

  let signedRaw: string;
  if (claimed.kind === 'resume') {
    signedRaw = claimed.signedRaw;
  } else {
    signedRaw = await opts.sign();
    await opts.store.putSigned(opts.idempotencyKey, signedRaw);
  }

  // Fail closed: never invoke RPC unless the signed payload is already journalled.
  if (!signedRaw || !(await opts.store.hasSigned(opts.idempotencyKey))) {
    throw new Error(`durable broadcast refused for ${opts.idempotencyKey}: putSigned must precede RPC`);
  }

  const hash = await opts.broadcast(signedRaw);
  return opts.store.put(opts.idempotencyKey, hash);
}
