/**
 * Operator loan book. Bands use `risk.ts` rounding and the thresholds stored
 * on the loan at opening, not the live product row. A loan whose asset has no
 * usable mark is `unpriced` with `bank.loan_health_price_unset`, never healthy.
 * Outstanding principal is the write-once aggregate, per asset, as a decimal string.
 * This does not seize.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { ltvBps, valueAt, type Mark } from '../loans/risk.js';

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

export type LoanBand = 'healthy' | 'marginCall' | 'liquidation';

/** Same cut `planLiquidation` uses, without the grace demotion. At the boundary the loan is in the higher band. */
export function bandAtOpeningThresholds(ltv: number, marginCallLtvBps: number, liquidationLtvBps: number): LoanBand {
  if (ltv < marginCallLtvBps) return 'healthy';
  if (ltv < liquidationLtvBps) return 'marginCall';
  return 'liquidation';
}

export interface LoanBook {
  asOf: string;
  openCount: number;
  outstandingPrincipal: Array<{ assetId: string; amount: string }>;
  bands: { healthy: number; marginCall: number; liquidation: number; unpriced: number };
  unpriced: Array<{ loanId: string; reason: 'bank.loan_health_price_unset' | 'bank.loan_opening_thresholds_unset' }>;
  oldestPending: { id: string; ageSeconds: number } | null;
}

interface BookLoan {
  id: string;
  userId: string;
  quoteAssetId: string;
  debtAssetId: string;
  collateralAssetId: string;
}

export interface LoanBookSource {
  sql: Sql;
  loan(id: string): Promise<BookLoan>;
  outstanding(id: string): Promise<{ principal: Amount; total: Amount }>;
  collateralOf(loan: BookLoan): Promise<Amount>;
  marksAccepted(assetIds: readonly string[], quoteAssetId: string, now: Date): Promise<ReadonlyMap<string, Mark>>;
}

const OPEN = ['active', 'margin_call', 'liquidating'] as const;

export async function readLoanBook(source: LoanBookSource, now = new Date()): Promise<LoanBook> {
  const rows = await source.sql<
    Array<{
      id: string;
      status: string;
      opened_at: Date;
      margin_call_ltv_bps: number | null;
      liquidation_ltv_bps: number | null;
    }>
  >`
    SELECT id, status::text AS status, opened_at, margin_call_ltv_bps, liquidation_ltv_bps
      FROM bank.loans
     ORDER BY opened_at ASC, id ASC
  `;

  const bands = { healthy: 0, marginCall: 0, liquidation: 0, unpriced: 0 };
  const unpriced: LoanBook['unpriced'] = [];
  const principal = new Map<string, Amount>();
  const open = rows.filter((row) => (OPEN as readonly string[]).includes(row.status));
  const loans = new Map<string, BookLoan>();
  for (const row of open) loans.set(row.id, await source.loan(row.id));

  const quotes = new Map<string, Set<string>>();
  for (const loan of loans.values()) {
    const set = quotes.get(loan.quoteAssetId) ?? new Set<string>();
    set.add(loan.debtAssetId);
    set.add(loan.collateralAssetId);
    quotes.set(loan.quoteAssetId, set);
  }
  const marksByQuote = new Map<string, ReadonlyMap<string, Mark>>();
  for (const [quote, assets] of quotes) {
    marksByQuote.set(quote, await source.marksAccepted([...assets], quote, now));
  }

  for (const row of open) {
    const loan = loans.get(row.id)!;
    const debt = await source.outstanding(loan.id);
    principal.set(loan.debtAssetId, (principal.get(loan.debtAssetId) ?? 0n) + debt.principal);

    if (row.margin_call_ltv_bps === null || row.liquidation_ltv_bps === null) {
      bands.unpriced += 1;
      unpriced.push({ loanId: loan.id, reason: 'bank.loan_opening_thresholds_unset' });
      continue;
    }
    const marks = marksByQuote.get(loan.quoteAssetId) ?? new Map<string, Mark>();
    if (!marks.has(loan.debtAssetId) || !marks.has(loan.collateralAssetId)) {
      bands.unpriced += 1;
      unpriced.push({ loanId: loan.id, reason: 'bank.loan_health_price_unset' });
      continue;
    }
    const collateral = await source.collateralOf(loan);
    const debtValue = valueAt([{ assetId: loan.debtAssetId, quantity: debt.total }], marks, 'ceil');
    const collateralValue = valueAt([{ assetId: loan.collateralAssetId, quantity: collateral }], marks, 'floor');
    const band = bandAtOpeningThresholds(ltvBps(debtValue, collateralValue), row.margin_call_ltv_bps, row.liquidation_ltv_bps);
    bands[band] += 1;
  }

  const oldest = rows.find((row) => row.status === 'pending') ?? null;
  return {
    asOf: now.toISOString(),
    openCount: open.length,
    outstandingPrincipal: [...principal.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([assetId, amount]) => ({ assetId, amount: formatAmount(amount) })),
    bands,
    unpriced,
    oldestPending: oldest
      ? { id: oldest.id, ageSeconds: Math.max(0, Math.floor((now.getTime() - oldest.opened_at.getTime()) / 1000)) }
      : null,
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function loanBookProcedure(read: () => Promise<LoanBook>, guard: Guard) {
  return scopedProcedure('admin:read')
    .output(
      z.object({
        asOf: z.string(),
        openCount: z.number().int().nonnegative(),
        outstandingPrincipal: z.array(z.object({ assetId: z.string(), amount: amountString })),
        bands: z.object({
          healthy: z.number().int().nonnegative(),
          marginCall: z.number().int().nonnegative(),
          liquidation: z.number().int().nonnegative(),
          unpriced: z.number().int().nonnegative(),
        }),
        unpriced: z.array(
          z.object({
            loanId: z.string(),
            reason: z.enum(['bank.loan_health_price_unset', 'bank.loan_opening_thresholds_unset']),
          }),
        ),
        oldestPending: z.object({ id: z.string(), ageSeconds: z.number().int().nonnegative() }).nullable(),
      }),
    )
    .query(() => guard(() => read()));
}
