import { waitMined, type MinedOutcome } from '../../protocol/wallet/WalletProvider';

/** How long the room waits for one deal transaction to be mined before it says it is still pending. */
export const DEAL_MINED_TIMEOUT_MS = 60_000;

type Refusal = { ok: false; message?: string; code?: string };

/**
 * What became of the seller's lock: attached to the order, reverted on the chain, still not mined, or mined and
 * then refused by the order. The deal is attached only once its lock receipt says success.
 */
export type LockOutcome = { kind: 'attached' } | { kind: 'reverted' } | { kind: 'pending' } | { kind: 'refused'; message: string };

export async function attachWhenLocked(input: {
  readReceipt: (hash: string) => Promise<unknown>;
  lockHash: string;
  attach: () => Promise<{ ok: true } | Refusal>;
  timeoutMs?: number;
}): Promise<LockOutcome> {
  const mined: MinedOutcome = await waitMined(input.readReceipt, input.lockHash, input.timeoutMs ?? DEAL_MINED_TIMEOUT_MS);
  if (mined.status === 'reverted') return { kind: 'reverted' };
  if (mined.status === 'timeout') return { kind: 'pending' };
  const attached = await input.attach();
  return attached.ok
    ? { kind: 'attached' }
    : { kind: 'refused', message: attached.message || attached.code || 'the deal could not be attached' };
}

/** A lock sent but not yet attached, kept in this browser so a reload or a slow chain does not lose the deal id. */
export interface PendingLock {
  dealId: string;
  lockHash: string;
}

const key = (tradeId: string) => `pay.contract-lock:${tradeId}`;

export const pendingLocks = {
  read(tradeId: string): PendingLock | null {
    try {
      const raw = localStorage.getItem(key(tradeId));
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<PendingLock>;
      return typeof value.dealId === 'string' && typeof value.lockHash === 'string'
        ? { dealId: value.dealId, lockHash: value.lockHash }
        : null;
    } catch {
      return null;
    }
  },
  write(tradeId: string, lock: PendingLock) {
    try {
      localStorage.setItem(key(tradeId), JSON.stringify(lock));
    } catch {
      /* storage unavailable: the deal id stays on screen for this visit */
    }
  },
  clear(tradeId: string) {
    try {
      localStorage.removeItem(key(tradeId));
    } catch {
      /* nothing to clear */
    }
  },
};
