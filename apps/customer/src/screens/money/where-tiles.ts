/**
 * Assets' three tiles (the owner's Money target, 25 Nov): what can be withdrawn now, what is locked, and what is on its
 * way into the venue account. Each is worked out only from what the page already reads: the venue's own rows (its
 * withdrawable and locked figures), the wallet's rows read from the chain, the venue's deposits still confirming, and
 * the published prices the total uses. A source not read yet, or one that failed, makes its tile say so (`known:
 * false`), never a zero. An amount with no published price is named in `unpriced` and left out of the figure.
 *
 * Money: decimal strings in, scaled bigints (18 places) inside, decimal strings out.
 */
import { div, formatAmount, mul, parseAmount } from '@intafaced/money-math';
import type { VenueRow } from './where-it-sits';

export interface TileAmount {
  asset: string;
  amount: string;
}

export interface TileInput {
  /** The venue's own rows; null while not read or after a failed read. */
  venue: readonly VenueRow[] | null;
  /** The wallet's rows read from the chain; null while not read or after a failed read. */
  wallet: readonly TileAmount[] | null;
  /** Deposits the venue reports as still confirming; null while not read or after a failed read. */
  moving: readonly TileAmount[] | null;
  /** The published USD price of an asset, or null with none. */
  priceOf: (asset: string) => string | null;
}

export interface Tile {
  /** Every source the tile adds up was read. */
  known: boolean;
  /** The priced sum in USD, or null when nothing in it is priced (or it is not known). */
  valueUsd: string | null;
  /** Assets in the tile with no published price, left out of `valueUsd`. */
  unpriced: string[];
  /** Whether anything at all is in it (an amount above zero). */
  any: boolean;
  /** Withdrawable only: a source that did not answer, left out of a figure made of the ones that did. */
  missing?: Array<'wallet' | 'venue'>;
}

export interface LockedPart {
  asset: string;
  amount: string;
  kind: 'in-orders' | 'collateral' | 'stake' | 'delegated' | 'unstaking' | 'locked';
}

export interface Tiles {
  withdrawable: Tile;
  locked: Tile;
  moving: Tile;
  /** What makes the locked figure, each part as the venue names it (or plain "locked" where it does not split it). */
  lockedParts: LockedPart[];
  /** Each known tile's share of the known tiles' sum, as a ratio string (null: that tile is not known); null when the sum is zero. */
  shares: { withdrawable: string | null; locked: string | null; moving: string | null } | null;
}

const isPositive = (amount: string) => {
  try {
    return parseAmount(amount) > 0n;
  } catch {
    return false;
  }
};

function tileOf(amounts: readonly TileAmount[] | null, priceOf: TileInput['priceOf']): Tile {
  if (amounts === null) return { known: false, valueUsd: null, unpriced: [], any: false };
  let sum = 0n;
  let priced = false;
  const unpriced = new Set<string>();
  let any = false;
  for (const { asset, amount } of amounts) {
    if (!isPositive(amount)) continue;
    any = true;
    const price = priceOf(asset);
    if (price === null) {
      unpriced.add(asset);
      continue;
    }
    sum += mul(parseAmount(amount), parseAmount(price), 'half-up');
    priced = true;
  }
  return { known: true, valueUsd: priced || !any ? formatAmount(sum) : null, unpriced: [...unpriced], any };
}

function lockedPartsOf(rows: readonly VenueRow[]): LockedPart[] {
  const parts: LockedPart[] = [];
  for (const row of rows) {
    if (!isPositive(row.locked)) continue;
    if (!row.split) {
      parts.push({ asset: row.asset, amount: row.locked, kind: 'locked' });
      continue;
    }
    const named: Array<[LockedPart['kind'], string | undefined]> = [
      ['in-orders', row.split.inOrders],
      ['collateral', row.split.collateral],
      ['stake', row.split.stake],
      ['delegated', row.split.delegated],
      ['unstaking', row.split.unstaking],
    ];
    for (const [kind, amount] of named) if (amount !== undefined && isPositive(amount)) parts.push({ asset: row.asset, amount, kind });
  }
  return parts;
}

export function tilesOf({ venue, wallet, moving, priceOf }: TileInput): Tiles {
  // Withdrawable adds the sources that answered; one that did not is named in `missing` and left out, never counted as zero.
  const withdrawable: Tile = {
    ...tileOf(
      venue === null && wallet === null
        ? null
        : [...(venue ?? []).map((row) => ({ asset: row.asset, amount: row.withdrawable })), ...(wallet ?? []).map((row) => ({ ...row }))],
      priceOf,
    ),
    missing:
      venue === null && wallet === null
        ? []
        : [...(wallet === null ? ['wallet' as const] : []), ...(venue === null ? ['venue' as const] : [])],
  };
  const locked = tileOf(venue === null ? null : venue.map((row) => ({ asset: row.asset, amount: row.locked })), priceOf);
  const movingTile = tileOf(moving, priceOf);
  // The bar draws the tiles whose figure is known; a tile not read is left out of it, never drawn as zero.
  const value = (tile: Tile) => (tile.known && tile.valueUsd !== null ? parseAmount(tile.valueUsd) : null);
  const values = { withdrawable: value(withdrawable), locked: value(locked), moving: value(movingTile) };
  const total = Object.values(values).reduce<bigint>((sum, v) => sum + (v ?? 0n), 0n);
  const share = (v: bigint | null) => (v === null ? null : formatAmount(div(v, total, 'half-up')));
  return {
    withdrawable,
    locked,
    moving: movingTile,
    lockedParts: venue === null ? [] : lockedPartsOf(venue),
    shares: total > 0n ? { withdrawable: share(values.withdrawable), locked: share(values.locked), moving: share(values.moving) } : null,
  };
}
