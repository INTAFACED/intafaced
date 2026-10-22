/**
 * What each lock on a coin is for, in the bank's own words (W-balances-01). The bank's balance breakdown names every
 * claim by its purpose (`order:<id>` for an open order's hold, `withdraw:<id>` for a withdrawal); this turns one claim
 * into a line a person can read. Nothing is added up here that the bank did not return: the amounts are passed through.
 */
import { add, dec, str } from '../../data/decimal';
import type { Decimal } from '../../data';
import type { LockSplit } from './portfolio-source';

export type SetAsideWhat =
  | { kind: 'order'; id: string }
  | { kind: 'withdrawal'; id: string }
  | { kind: 'hold' | 'escrow' | 'stake' | 'collateral'; purpose: string }
  | { kind: 'other'; lock: string; purpose: string };

export interface SetAsideLine {
  what: SetAsideWhat;
  amount: Decimal;
}

const NAMED_LOCKS = new Set(['hold', 'escrow', 'stake', 'collateral']);

/** One claim, named. An order or a withdrawal is named by its id; every other claim keeps the bank's purpose as is. */
export function setAsideWhat(lock: string, purpose: string): SetAsideWhat {
  if (lock === 'hold') {
    const order = /^order:(.+)$/.exec(purpose);
    if (order) return { kind: 'order', id: order[1]! };
    const withdrawal = /^withdraw:(.+)$/.exec(purpose);
    if (withdrawal) return { kind: 'withdrawal', id: withdrawal[1]! };
  }
  return NAMED_LOCKS.has(lock) ? { kind: lock as 'hold' | 'escrow' | 'stake' | 'collateral', purpose } : { kind: 'other', lock, purpose };
}

/** Every claim on the coin, largest first, then by name, so the order is the same on every read. */
export function setAsideLines(split: LockSplit | undefined): SetAsideLine[] {
  if (!split) return [];
  return split.claims
    .map((claim) => ({ what: setAsideWhat(claim.kind, claim.purpose), amount: claim.amount, key: `${claim.kind}:${claim.purpose}` }))
    .sort((a, b) => {
      const x = dec(a.amount) ?? 0n;
      const y = dec(b.amount) ?? 0n;
      return x === y ? a.key.localeCompare(b.key) : x > y ? -1 : 1;
    })
    .map(({ what, amount }) => ({ what, amount }));
}

/** The first eight characters of an id: enough to tell two orders apart on screen; the full id goes in the title. */
export const shortId = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);

/**
 * Available plus every claim, and whether that is the total the bank returned for the coin. Null when a figure does not
 * parse, so no sum is claimed.
 */
export function setAsideSum(split: LockSplit, total: Decimal): { setAside: Decimal; adds: boolean } | null {
  const available = dec(split.available);
  const whole = dec(total);
  const claims = split.claims.map((claim) => dec(claim.amount));
  if (available === null || whole === null || claims.some((amount) => amount === null)) return null;
  const setAside = claims.reduce<bigint>((sum, amount) => add(sum, amount!), 0n);
  return { setAside: str(setAside), adds: add(available, setAside) === whole };
}
