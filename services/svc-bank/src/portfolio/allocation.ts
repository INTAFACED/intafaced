import { div, formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Holding, PortfolioSummary, UnpricedRow } from './valuation.js';

/**
 * ALLOCATION (PF-balances-02). The priced holdings of the total-value rule, grouped; nothing new is priced here.
 *
 * Class comes from the code of the asset, written once below: USD is `fiat`, the par assets USDT and USDC are
 * `stablecoin`, every other asset that has a price is `crypto`. An asset with no price is not in any share (the same
 * rule as the total) and is listed apart under `unpriced`. Type is where the money sits: `available` (spendable) or
 * `locked` (order, escrow, stake, loan collateral), from the same holdings. Each grouping adds up to `totalValueUsd`
 * exactly; a share is value / total at 18 places, so shares can differ from 1 by the last place.
 */

export const ALLOCATION_CLASSES = ['fiat', 'stablecoin', 'crypto'] as const;
export type AllocationClass = (typeof ALLOCATION_CLASSES)[number];
export const ALLOCATION_TYPES = ['available', 'locked'] as const;
export type AllocationType = (typeof ALLOCATION_TYPES)[number];

const FIAT: ReadonlySet<string> = new Set(['USD']);
const STABLECOINS: ReadonlySet<string> = new Set(['USDT', 'USDC']);

export function classOf(asset: string): AllocationClass {
  const code = asset.toUpperCase();
  if (FIAT.has(code)) return 'fiat';
  if (STABLECOINS.has(code)) return 'stablecoin';
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

export function allocate(summary: PortfolioSummary, holdings: readonly Holding[]): PortfolioAllocation {
  const usedByAsset = new Map<string, Amount>(holdings.map((h) => [h.assetId, h.used]));
  const lines = summary.priced.map((row) => {
    const value = parseAmount(row.valueUsd);
    const used = usedByAsset.get(row.asset) ?? 0n;
    // Locked value is rounded once; available is what remains, so the two parts equal the row exactly.
    const locked = used > 0n ? mul(used, parseAmount(row.priceUsd), 'half-up') : 0n;
    return { asset: row.asset, value, locked, available: value - locked, cls: classOf(row.asset) };
  });
  const total = lines.reduce<Amount>((sum, line) => sum + line.value, 0n);
  const share = (value: Amount): string => (total > 0n ? formatAmount(div(value, total, 'half-up')) : '0');

  const classes: AllocationClassRow[] = [];
  for (const cls of ALLOCATION_CLASSES) {
    const members = lines
      .filter((line) => line.cls === cls)
      .sort((a, b) => (a.value === b.value ? a.asset.localeCompare(b.asset) : a.value > b.value ? -1 : 1));
    if (members.length === 0) continue;
    const value = members.reduce<Amount>((sum, line) => sum + line.value, 0n);
    classes.push({
      class: cls,
      valueUsd: formatAmount(value),
      share: share(value),
      assets: members.map((line) => ({ asset: line.asset, valueUsd: formatAmount(line.value), share: share(line.value) })),
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
