import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { assertSelf } from '../assert-self.js';
import { amountString } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createEarnRouter(c: BankRouterContext) {
  const { bank } = c;
  return router({
    pools: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16).optional(),
          /**
           * Page size. Optional so omit reaches `bank.earn_pools_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            assetId: z.string(),
            kind: z.enum(['flexible', 'fixed']),
            name: z.string(),
            aprBps: z.number().int(),
            termDays: z.number().int().nullable(),
            minDeposit: amountString,
          }),
        ),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const pools = await bank.earn.listPools(input.assetId, input.limit);
          return pools.map((p) => ({
            id: p.id,
            assetId: p.assetId,
            kind: p.kind,
            name: p.name,
            aprBps: p.aprBps,
            termDays: p.termDays,
            minDeposit: formatAmount(p.minDeposit),
          }));
        }),
      ),

    deposit: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ poolId: z.string().guid(), amount: amountString, positionId: z.string().guid() }))
      .output(z.object({ positionId: z.string(), maturesAt: z.string().nullable() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          // The desk supply pause is checked inside earn.deposit, so every caller respects it.
          const position = await bank.earn.deposit({
            poolId: input.poolId,
            userId: ctx.principal.userId,
            amount: parseAmount(input.amount),
            positionId: input.positionId,
          });
          return { positionId: position.id, maturesAt: position.maturesAt?.toISOString() ?? null };
        }),
      ),

    withdraw: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ positionId: z.string().guid() }))
      .output(z.object({ positionId: z.string(), principal: amountString }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const existing = await bank.earn.position(input.positionId);
          assertSelf(ctx.principal.userId, existing.userId);
          const closed = await bank.earn.withdraw(input.positionId);
          return { positionId: closed.id, principal: formatAmount(closed.principal) };
        }),
      ),

    positions: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.earn_positions_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            poolId: z.string(),
            assetId: z.string(),
            principal: amountString,
            maturesAt: z.string().nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const positions = await bank.earn.positionsOf(ctx.principal.userId, input?.limit);
          return positions.map((p) => ({
            id: p.id,
            poolId: p.poolId,
            assetId: p.assetId,
            principal: formatAmount(p.principal),
            maturesAt: p.maturesAt?.toISOString() ?? null,
          }));
        }),
      ),

    /** The caller's interest from one pool, a row per paid day, and what every paid day sums to (J-bank-07 #5). */
    interestHistory: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          poolId: z.string().guid(),
          /** Page size. Optional so omit reaches `bank.earn_interest_list_limit_unset`; blank is not 50. */
          limit: z.number().int().min(1).max(200).optional(),
          /** Older days only: the oldest day of the page before (a date, exclusive). */
          before: z.string().date().optional(),
        }),
      )
      .output(
        z.object({
          days: z.array(z.object({ date: z.string(), rateBps: z.number().int(), amount: amountString, ledgerTxId: z.string() })),
          total: amountString,
          unitemisedDays: z.number().int(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const history = await bank.earn.interestHistory(ctx.principal.userId, input.poolId, input.limit, input.before);
          return {
            days: history.days.map((d) => ({ ...d, amount: formatAmount(d.amount) })),
            total: formatAmount(history.total),
            unitemisedDays: history.unitemisedDays,
          };
        }),
      ),
  });
}
