/**
 * Account margin summary. Exact decimal strings. A null input nulls every
 * figure that depends on it and names the field. Buying power is computed only
 * from a published haircut; a blank haircut is `haircut_unset`, never a guess.
 */
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { collateralCredit } from './haircut-credit.js';

export const MISSING_INPUT = 'missing_input' as const;
export const HAIRCUT_UNSET_SUMMARY = 'haircut_unset' as const;

export interface MarginSummaryPosition {
  readonly initialMargin: string | null;
  readonly maintenanceMargin: string | null;
  readonly collateral: string | null;
  readonly unrealizedPnl: string | null;
}

export interface MarginSummaryMissing {
  readonly field: string;
  readonly code: typeof MISSING_INPUT | typeof HAIRCUT_UNSET_SUMMARY;
}

export interface MarginSummary {
  readonly totalInitialMargin: string | null;
  readonly totalMaintenanceMargin: string | null;
  readonly equity: string | null;
  readonly excess: string | null;
  readonly deficit: string | null;
  readonly marginRatio: string | null;
  readonly buyingPower: string | null;
  readonly missing: readonly MarginSummaryMissing[];
}

function sumField(
  positions: readonly MarginSummaryPosition[],
  field: 'initialMargin' | 'maintenanceMargin',
): { readonly value: Amount | null; readonly missing: boolean } {
  if (positions.length === 0) return { value: 0n, missing: false };
  let total = 0n;
  for (const row of positions) {
    const raw = row[field];
    if (raw == null) return { value: null, missing: true };
    total += parseAmount(raw);
  }
  return { value: total, missing: false };
}

function equityOf(positions: readonly MarginSummaryPosition[]): {
  readonly value: Amount | null;
  readonly field: 'collateral' | 'unrealizedPnl' | null;
} {
  if (positions.length === 0) return { value: 0n, field: null };
  let total = 0n;
  for (const row of positions) {
    if (row.collateral == null) return { value: null, field: 'collateral' };
    if (row.unrealizedPnl == null) return { value: null, field: 'unrealizedPnl' };
    total += parseAmount(row.collateral) + parseAmount(row.unrealizedPnl);
  }
  return { value: total, field: null };
}

export function summarizeMargin(input: {
  readonly positions: readonly MarginSummaryPosition[];
  readonly available: string | null;
  readonly haircutBps: number | null;
}): MarginSummary {
  const missing: MarginSummaryMissing[] = [];
  const initial = sumField(input.positions, 'initialMargin');
  const maintenance = sumField(input.positions, 'maintenanceMargin');
  const equity = equityOf(input.positions);

  if (initial.missing) missing.push({ field: 'initialMargin', code: MISSING_INPUT });
  if (maintenance.missing) missing.push({ field: 'maintenanceMargin', code: MISSING_INPUT });
  if (equity.field) missing.push({ field: equity.field, code: MISSING_INPUT });

  const totalInitialMargin = initial.value == null ? null : formatAmount(initial.value);
  const totalMaintenanceMargin = maintenance.value == null ? null : formatAmount(maintenance.value);
  const equityText = equity.value == null ? null : formatAmount(equity.value);

  let excess: string | null = null;
  let deficit: string | null = null;
  let marginRatio: string | null = null;
  if (input.positions.length === 0) {
    excess = '0';
    deficit = '0';
    marginRatio = null;
  } else if (equity.value != null && maintenance.value != null) {
    if (equity.value >= maintenance.value) {
      excess = formatAmount((equity.value - maintenance.value) as Amount);
      deficit = '0';
    } else {
      excess = '0';
      deficit = formatAmount((maintenance.value - equity.value) as Amount);
    }
    if (equity.value > 0n) {
      const SCALE = 10n ** 18n;
      const ratio = (maintenance.value * SCALE) / equity.value;
      marginRatio = formatAmount(ratio as Amount);
    }
  }

  let buyingPower: string | null = null;
  if (input.haircutBps == null) {
    missing.push({ field: 'TRADE_COLLATERAL_HAIRCUT_BPS', code: HAIRCUT_UNSET_SUMMARY });
  } else if (input.available == null) {
    missing.push({ field: 'available', code: MISSING_INPUT });
  } else if (initial.value == null) {
    buyingPower = null;
  } else {
    const credit = collateralCredit(parseAmount(input.available), input.haircutBps);
    buyingPower = formatAmount((credit - initial.value) as Amount);
  }

  return {
    totalInitialMargin,
    totalMaintenanceMargin,
    equity: equityText,
    excess,
    deficit,
    marginRatio,
    buyingPower,
    missing,
  };
}
