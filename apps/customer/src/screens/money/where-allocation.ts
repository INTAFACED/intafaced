/**
 * Allocation on the launch model (J-portfolio-06 #1, PF-balances-02): groups the priced holdings of `standing.ts` by
 * coin, by class (`fiat`, `stablecoin`, `crypto`, `commodity`, `earn`, `unclassified`) and by place (`available`,
 * `locked`). Uses only the sources already read (wallet, venue, partner) and the published valuation prices; nothing
 * comes from our own ledger's balances.
 *
 * Money: decimal strings in, scaled bigints (18 places) inside, decimal strings out. Every grouping adds up to the
 * exact `totalValueUsd` of the priced rows, and each share is `value / total` at 18 places, half-up.
 */
import { div, formatAmount, mul, parseAmount, type Amount } from '@intafaced/money-math';
import type { Standing } from './standing';
import type { VenueRow } from './where-it-sits';

const ALLOCATION_CLASSES = ['fiat', 'stablecoin', 'crypto', 'commodity', 'earn', 'unclassified'] as const;
export type WhereAllocationClass = (typeof ALLOCATION_CLASSES)[number];
export type WhereAllocationType = 'available' | 'locked';

export interface WhereShare {
  asset: string;
  valueUsd: string;
  share: string;
}

export interface WhereClassRow {
  class: WhereAllocationClass;
  valueUsd: string;
  share: string;
  assets: WhereShare[];
}

export interface WhereTypeRow {
  type: WhereAllocationType;
  valueUsd: string;
  share: string;
}

export interface WhereAllocation {
  totalValueUsd: string;
  coins: WhereShare[];
  classes: WhereClassRow[];
  classesRefused: 'bank.asset_registry_unavailable' | null;
  types: WhereTypeRow[];
  unpriced: string[];
}

const SCALE: Amount = 10n ** 18n;

/** The class of an asset outside its earn part, matching svc-bank's `allocation.rs` rule. */
export function classOf(asset: string, kinds: ReadonlyMap<string, string>): WhereAllocationClass {
  const code = asset.toUpperCase();
  if (code === 'USDT' || code === 'USDC') return 'stablecoin';
  if (code === 'USD') return 'fiat';
  const kind = kinds.get(code);
  if (kind === undefined) return 'unclassified';
  if (kind === 'fiat') return 'fiat';
  if (kind === 'commodity') return 'commodity';
  return 'crypto';
}

function ratio(value: Amount, total: Amount): string {
  if (total <= 0n || value <= 0n) return '0';
  return formatAmount(div(mul(value, SCALE), total, 'half-up'));
}

function byValueDesc<T extends { value: Amount; key: string }>(a: T, b: T): number {
  return a.value === b.value ? a.key.localeCompare(b.key) : a.value > b.value ? -1 : 1;
}

/**
 * Groups `standing`'s priced holdings by coin, class and place using the venue's free/locked/stake split and vault
 * positions. `kinds` is the upper-case asset id → kind map from `assets.list`; `null` leaves `classes` empty with
 * `classesRefused` set so the room never guesses classes when the registry could not be read.
 */
export function allocateStanding(
  standing: Standing,
  venueRows: readonly VenueRow[],
  kinds: ReadonlyMap<string, string> | null,
): WhereAllocation {
  const venueByAsset = new Map(venueRows.map((row) => [row.asset, row]));
  const coinTotals = new Map<string, Amount>();
  const classBuckets = new Map<WhereAllocationClass, Map<string, Amount>>();
  let availableTotal: Amount = 0n;
  let lockedTotal: Amount = 0n;
  let total: Amount = 0n;

  const addToClass = (cls: WhereAllocationClass, asset: string, value: Amount) => {
    if (value <= 0n) return;
    let bucket = classBuckets.get(cls);
    if (!bucket) {
      bucket = new Map<string, Amount>();
      classBuckets.set(cls, bucket);
    }
    bucket.set(asset, (bucket.get(asset) ?? 0n) + value);
  };

  for (const part of standing.parts) {
    if (part.state !== 'read') continue;
    for (const row of part.rows) {
      if (row.valueUsd === null || row.priceUsd === null) continue;
      const value = parseAmount(row.valueUsd);
      if (value <= 0n) continue;
      const price = parseAmount(row.priceUsd);
      total += value;
      coinTotals.set(row.asset, (coinTotals.get(row.asset) ?? 0n) + value);

      let locked: Amount = 0n;
      let earn: Amount = 0n;
      if (part.id === 'venue' && row.key?.startsWith('vault:')) {
        locked = value;
        earn = value;
      } else if (part.id === 'venue') {
        const venueRow = venueByAsset.get(row.asset);
        const lockedQty = venueRow ? parseAmount(venueRow.locked) : 0n;
        if (lockedQty > 0n) {
          const computed = mul(lockedQty, price);
          locked = computed > value ? value : computed;
        }
        const split = venueRow?.split;
        const earnQty = split ? parseAmount(split.stake) + parseAmount(split.delegated ?? '0') + parseAmount(split.unstaking ?? '0') : 0n;
        if (earnQty > 0n && locked > 0n) {
          if (earnQty >= lockedQty) earn = locked;
          else {
            const computed = mul(earnQty, price);
            earn = computed > locked ? locked : computed;
          }
        }
      }

      const available = value - locked;
      availableTotal += available;
      lockedTotal += locked;

      if (kinds !== null) {
        addToClass(classOf(row.asset, kinds), row.asset, value - earn);
        addToClass('earn', row.asset, earn);
      }
    }
  }

  const coins = [...coinTotals.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort(byValueDesc)
    .map(({ key, value }) => ({ asset: key, valueUsd: formatAmount(value), share: ratio(value, total) }));

  const classes: WhereClassRow[] = [];
  if (kinds !== null) {
    for (const cls of ALLOCATION_CLASSES) {
      const bucket = classBuckets.get(cls);
      if (!bucket || bucket.size === 0) continue;
      const members = [...bucket.entries()].map(([key, value]) => ({ key, value })).sort(byValueDesc);
      const classValue = members.reduce((acc, m) => acc + m.value, 0n);
      classes.push({
        class: cls,
        valueUsd: formatAmount(classValue),
        share: ratio(classValue, total),
        assets: members.map(({ key, value }) => ({ asset: key, valueUsd: formatAmount(value), share: ratio(value, total) })),
      });
    }
  }

  const types: WhereTypeRow[] =
    total <= 0n
      ? []
      : [
          { type: 'available', valueUsd: formatAmount(availableTotal), share: ratio(availableTotal, total) },
          { type: 'locked', valueUsd: formatAmount(lockedTotal), share: ratio(lockedTotal, total) },
        ];

  return {
    totalValueUsd: formatAmount(total),
    coins,
    classes,
    classesRefused: kinds === null ? 'bank.asset_registry_unavailable' : null,
    types,
    unpriced: [...standing.unpriced],
  };
}
