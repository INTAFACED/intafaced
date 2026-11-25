import type { useHomeStanding } from './HomeStanding';

type Standing = NonNullable<ReturnType<typeof useHomeStanding>>;
type SplitId = 'cash' | 'crypto' | 'trading' | 'earn' | 'web3';

/** One part of the split: its dollar value as its source reports it, or null when Home does not read it (never zero). */
export type Split = Record<SplitId, string | null>;

/**
 * The launch model's split (the owner's Home A): Cash is the partner account, Crypto the person's own wallet, Trading
 * the venue account, each the same valued figure the total adds. Earn and Web3 have no read on Home, so they stay null.
 * A part that could not be read is null too.
 */
export function standingSplit(standing: Standing): Split {
  const of = (id: 'partner' | 'wallet' | 'venue') => {
    const part = standing.parts.find((p) => p.id === id);
    // No such source for this person (no partner account): it holds nothing, which is known, not unread.
    if (!part) return '0';
    if (part.state !== 'read') return null;
    return part.valueUsd ?? (part.rows.length === 0 ? '0' : null);
  };
  return { cash: of('partner'), crypto: of('wallet'), trading: of('venue'), earn: null, web3: null };
}
