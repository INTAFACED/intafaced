import { div, formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { RegistryAssetKind } from '@intafaced/contracts';
import type { Holding, PortfolioSummary, UnpricedRow } from './valuation.js';

/**
 * ALLOCATION (PF-balances-02). The priced holdings of the total-value rule, grouped; nothing new is priced here.
 *
 * Class comes from svc-ledger's asset registry (`kinds`, asset id -> registry kind): `fiat`, `crypto` (crypto and the native
 * token) and `commodity`, except the par assets USDT and USDC, which are `stablecoin` by their code. What sits in `stake`
 * accounts (earn and staked positions) is `earn`, whatever the coin. An asset the registry does not list (its precision is
 * not published) has no class: it lands in `unclassified`, named, and still counts in the total. An asset with no price is
 * not in any share (the same rule as the total) and is listed apart under `unpriced`. Type is where the money sits:
 * `available` (spendable) or `locked` (order, escrow, stake, loan collateral), from the same holdings. Each grouping adds
 * up to `totalValueUsd` exactly; a share is value / total at 18 places, so shares can differ from 1 by the last place.
 */

export const ALLOCATION_CLASSES = ['fiat', 'stablecoin', 'crypto', 'commodity', 'earn', 'unclassified'] as const;
export type AllocationClass = (typeof ALLOCATION_CLASSES)[number];
export const ALLOCATION_TYPES = ['available', 'locked'] as const;
export type AllocationType = (typeof ALLOCATION_TYPES)[number];

const STABLECOINS: ReadonlySet<string> = new Set(['USDT', 'USDC']);

/** The class of an asset's non-staked part. USD needs no registry: it is the base the total is counted in. */
export function classOf(asset: string, kinds: ReadonlyMap<string, RegistryAssetKind>): AllocationClass {
  const code = asset.toUpperCase();
  if (STABLECOINS.has(code)) return 'stablecoin';
  if (code === 'USD') return 'fiat';
  const kind = kinds.get(code);
  if (kind === undefined) return 'unclassified';
  if (kind === 'fiat') return 'fiat';
  if (kind === 'commodity') return 'commodity';
  return 'crypto';
}

export interface AllocationAsset {
  readonly asset: string;
  readonly valueUsd: string;
  readonly share: string;
}

export interface AllocationClassRow {
  readonly class: AllocationClass;
  readonly valueUsd: string;
  readonly share: string;
  readonly assets: AllocationAsset[];
}

export interface AllocationTypeRow {
  readonly type: AllocationType;
  readonly valueUsd: string;
  readonly share: string;
}

export interface PortfolioAllocation {
  /** Sum of every priced value, full precision. "0" when nothing priced is held. */
  readonly totalValueUsd: string;
  readonly classes: AllocationClassRow[];
  readonly types: AllocationTypeRow[];
  readonly unpriced: UnpricedRow[];
  readonly asOf: number;
}

export function allocate(
  summary: PortfolioSummary,
  holdings: readonly Holding[],
  kinds: ReadonlyMap<string, RegistryAssetKind>,
): PortfolioAllocation {
  const byAsset = new Map<string, Holding>(holdings.map((h) => [h.assetId, h]));
  const lines = summary.priced.map((row) => {
    const value = parseAmount(row.valueUsd);
    const price = parseAmount(row.priceUsd);
    const holding = byAsset.get(row.asset);
    const used = holding?.used ?? 0n;
    // Locked value is rounded once; available is what remains, so the two parts equal the row exactly. The staked part
    // of the locked value is rounded the same way and never exceeds it.
    const locked = used > 0n ? mul(used, price, 'half-up') : 0n;
    const stakedRaw = holding?.staked ?? 0n;
    const staked = stakedRaw <= 0n ? 0n : stakedRaw >= used ? locked : mul(stakedRaw, price, 'half-up');
    return { asset: row.asset, value, locked, staked, available: value - locked, cls: classOf(row.asset, kinds) };
  });
  const total = lines.reduce<Amount>((sum, line) => sum + line.value, 0n);
  const share = (value: Amount): string => (total > 0n ? formatAmount(div(value, total, 'half-up')) : '0');

  // One part per (class, asset): the staked value goes to `earn`, the rest to the asset's own class.
  const parts = lines.flatMap((line) => [
    { asset: line.asset, cls: line.cls, value: line.value - line.staked },
    { asset: line.asset, cls: 'earn' as AllocationClass, value: line.staked },
  ]);
  const classes: AllocationClassRow[] = [];
  for (const cls of ALLOCATION_CLASSES) {
    const members = parts
      .filter((part) => part.cls === cls && part.value > 0n)
      .sort((a, b) => (a.value === b.value ? a.asset.localeCompare(b.asset) : a.value > b.value ? -1 : 1));
    if (members.length === 0) continue;
    const value = members.reduce<Amount>((sum, part) => sum + part.value, 0n);
    classes.push({
      class: cls,
      valueUsd: formatAmount(value),
      share: share(value),
      assets: members.map((part) => ({ asset: part.asset, valueUsd: formatAmount(part.value), share: share(part.value) })),
    });
  }

  const availableValue = lines.reduce<Amount>((sum, line) => sum + line.available, 0n);
  const lockedValue = lines.reduce<Amount>((sum, line) => sum + line.locked, 0n);
  const types: AllocationTypeRow[] =
    lines.length === 0
      ? []
      : [
          { type: 'available', valueUsd: formatAmount(availableValue), share: share(availableValue) },
          { type: 'locked', valueUsd: formatAmount(lockedValue), share: share(lockedValue) },
        ];

  return { totalValueUsd: formatAmount(total), classes, types, unpriced: summary.unpriced, asOf: summary.asOf };
}
