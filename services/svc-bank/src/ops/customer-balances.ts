/**
 * A customer's balances for the finance-treasury desk (PF-balances-01, portfolio-balances-001 and -002).
 *
 * Read only, ledger reads only: the same `balanceBreakdown` and `balanceEntries` the customer sees, asked for the customer a
 * desk names. The operator needs `admin:treasury`; a customer's own session never reaches these. Who may hold that scope is
 * decided where scopes are granted (identity), so widening or narrowing the desk is a scope change and not a code change.
 * No audit table is merged for operator reads (the same as `ops.transferDetail`), so every read writes one structured log
 * line with the operator and the customer BEFORE any figure is read; if that line cannot be written the read refuses.
 * Nothing is inserted and there is no export.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { activityFailure } from '../activity/activity.router.js';
import { ActivityLookupBoundedError, ActivityUnavailableError } from '../activity/activity-service.js';
import { BankError } from '../errors.js';
import { BALANCE_ENTRIES_DEFAULT_LIMIT, BALANCE_ENTRIES_MAX_LIMIT } from '../portfolio/portfolio-service.js';

const signedAmount = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

export function writeCustomerBalancesAudit(actorUserId: string, ownerUserId: string, what: 'breakdown' | 'entries'): void {
  try {
    console.info(
      JSON.stringify({
        level: 'info',
        service: 'svc-bank',
        event: 'bank.ops.customer_balances_read',
        actorUserId,
        ownerUserId,
        what,
      }),
    );
  } catch {
    throw new BankError('The read could not be recorded, so nothing was read', 'bank.ops_audit_unavailable');
  }
}

export interface CustomerBalanceRow {
  assetId: string;
  total: string;
  available: string;
  hold: string;
  escrow: string;
  stake: string;
  collateral: string;
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

/** One flat row per asset: the lock kinds the ledger-client names, each as its own exact column ('0' when the customer has none). */
export function flattenBreakdown(
  assets: ReadonlyArray<{ assetId: string; total: string; available: string; locked: ReadonlyArray<{ kind: string; amount: string }> }>,
): CustomerBalanceRow[] {
  return assets.map((asset) => {
    const lock = (kind: string) => asset.locked.find((l) => l.kind === kind)?.amount ?? '0';
    return {
      assetId: asset.assetId,
      total: asset.total,
      available: asset.available,
      hold: lock('hold'),
      escrow: lock('escrow'),
      stake: lock('stake'),
      collateral: lock('collateral'),
    };
  });
}

export function customerBalancesProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:treasury')
    .input(z.object({ userId: z.string().uuid() }).strict())
    .output(
      z.object({
        userId: z.string(),
        assets: z.array(
          z.object({
            assetId: z.string(),
            total: signedAmount,
            available: signedAmount,
            hold: signedAmount,
            escrow: signedAmount,
            stake: signedAmount,
            collateral: signedAmount,
          }),
        ),
      }),
    )
    .query(({ ctx, input }) =>
      guard(async () => {
        writeCustomerBalancesAudit(ctx.principal.userId, input.userId, 'breakdown');
        const { assets } = await bank.portfolio.balanceBreakdown(input.userId, 'all');
        return { userId: input.userId, assets: flattenBreakdown(assets) };
      }),
    );
}

export function customerBalanceEntriesProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:treasury')
    .input(
      z
        .object({
          userId: z.string().uuid(),
          assetId: z.string().min(1).max(16),
          cursor: z.string().min(1).max(16).optional(),
          limit: z.number().int().min(1).max(BALANCE_ENTRIES_MAX_LIMIT).default(BALANCE_ENTRIES_DEFAULT_LIMIT),
        })
        .strict(),
    )
    .output(
      z.object({
        assetId: z.string(),
        entries: z.array(
          z.object({
            entryId: z.string().nullable(),
            txId: z.string(),
            accountId: z.string(),
            reason: z.string(),
            direction: z.enum(['debit', 'credit']),
            amount: signedAmount,
            postedAt: z.string(),
          }),
        ),
        nextCursor: z.string().nullable(),
        sumCheck: z.object({ ok: z.literal(true), entriesSum: signedAmount, balance: signedAmount, entryCount: z.number().int() }),
      }),
    )
    .query(({ ctx, input }) =>
      guard(async () => {
        writeCustomerBalancesAudit(ctx.principal.userId, input.userId, 'entries');
        try {
          return await bank.portfolio.balanceEntries(input.userId, {
            assetId: input.assetId,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            limit: input.limit,
          });
        } catch (err) {
          if (err instanceof ActivityUnavailableError || err instanceof ActivityLookupBoundedError) return activityFailure(err);
          throw err;
        }
      }),
    );
}
