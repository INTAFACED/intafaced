/**
 * Where each coin's Amount sits, for the Pro table: spendable now (Available), set aside for open orders (In orders)
 * and kept in named spaces (In spaces). The figures come from two bank calls and are shown as returned: the balance
 * call gives Available and In orders, the spaces list gives what each named space holds. Nothing here is worked out
 * from prices, and nothing is filled in to make a row add up: a figure the bank did not return is null.
 */
import { add, dec, str, sumOf, type Scaled } from '../../data/decimal';
import type { Decimal, Loadable } from '../../data';
import type { BalanceEntry } from '../../data/derive';
import type { LockSplit, NamedAccount } from './portfolio-source';

/**
 * known: the bank returned the spaces list. waiting: still loading. unavailable: the bank did not return it.
 * not-in-amount: the Amount was worked out on this device and leaves named spaces out, so none of it is in the Amount.
 */
export type SpacesState = 'known' | 'waiting' | 'unavailable' | 'not-in-amount';

export interface Spaces {
  state: SpacesState;
  /** What named spaces hold of each coin, added from the list as returned. Empty unless state is "known". */
  byAsset: ReadonlyMap<string, Scaled>;
}

export interface Held {
  available: Decimal | null;
  inOrders: Decimal | null;
  /** Escrow, stake and collateral together; null when the bank's lock breakdown was not returned (then "In orders" is every lock). */
  locked: Decimal | null;
  /** The locks with their claims, for the hover detail; empty when the breakdown was not returned. */
  claims: LockSplit['claims'];
  /** What named spaces hold of this coin; null when no spaces figure was returned. */
  inSpaces: Decimal | null;
  /**
   * True when Available + In orders + Locked + In spaces equals Amount exactly. False when all three are known and differ (the
   * two calls were read a moment apart). Null when one is missing, so no sum can be claimed.
   */
  adds: boolean | null;
}

/** The spaces figure for the table, from the spaces list and where the Amount came from. */
export function spacesFor(accounts: Loadable<NamedAccount[]>, source: 'server' | 'derived'): Spaces {
  if (source === 'derived') return { state: 'not-in-amount', byAsset: new Map() };
  if (accounts.status === 'empty') return { state: 'known', byAsset: new Map() };
  if (accounts.status === 'loading') return { state: 'waiting', byAsset: new Map() };
  if (accounts.status !== 'ready') return { state: 'unavailable', byAsset: new Map() };
  const balances = accounts.data.map((account) => ({ asset: account.asset, balance: dec(account.balance) }));
  // One unreadable balance would leave a silent gap in the sums: say the figure is missing instead.
  if (balances.some((row) => row.balance === null)) return { state: 'unavailable', byAsset: new Map() };
  const grouped = new Map<string, Scaled[]>();
  for (const row of balances) grouped.set(row.asset, [...(grouped.get(row.asset) ?? []), row.balance!]);
  return { state: 'known', byAsset: new Map([...grouped].map(([asset, values]) => [asset, sumOf(values)])) };
}

/** One coin's Available, In orders and In spaces next to its Amount. */
export function heldFor(
  asset: string,
  amount: Decimal,
  balance: BalanceEntry | undefined,
  spaces: Spaces,
  /** The bank's per-coin lock breakdown; `undefined` while it is not available, `null` entry never happens. */
  locks?: Record<string, LockSplit> | undefined,
): Held {
  // Worked out on this device the Amount leaves spaces out, so no spaces figure applies: shown as a dash, never as 0.
  const inSpaces: Scaled | null = spaces.state === 'known' ? (spaces.byAsset.get(asset) ?? 0n) : null;
  // With the bank's lock breakdown the "used" figure is told apart: orders on one side, escrow/stake/collateral on the other.
  // A coin missing from a breakdown that did arrive holds nothing in the main account.
  const split = locks === undefined ? undefined : (locks[asset] ?? { available: '0', inOrders: '0', locked: '0', claims: [] });
  const free = dec(split ? split.available : balance?.free);
  const used = dec(split ? split.inOrders : balance?.used);
  const lockedAmount = split ? dec(split.locked) : 0n;
  const total = dec(amount);
  const held = free === null || used === null || lockedAmount === null ? null : add(add(free, used), lockedAmount);
  const adds =
    held === null || total === null
      ? null
      : spaces.state === 'not-in-amount'
        ? held === total
        : inSpaces === null
          ? null
          : add(held, inSpaces) === total;
  return {
    available: split ? split.available : (balance?.free ?? null),
    inOrders: split ? split.inOrders : (balance?.used ?? null),
    locked: split ? split.locked : null,
    claims: split ? split.claims : [],
    inSpaces: inSpaces === null ? null : str(inSpaces),
    adds,
  };
}

/** True when every row with all three figures adds up; null when no row could be checked. */
export function allAdd(held: readonly Held[]): boolean | null {
  const checked = held.filter((row) => row.adds !== null);
  return checked.length === 0 ? null : checked.every((row) => row.adds === true);
}
