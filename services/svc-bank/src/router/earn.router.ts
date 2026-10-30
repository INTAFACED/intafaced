import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { assertSelf } from '../assert-self.js';
import { amountString } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';
import type { PoolRecord } from '../earn/earn-service.js';

/**
 * What a pool publishes beyond its rate and term (BK-earn-02, BK-earn-05), so the pool page and the side-by-side table
 * read the bank, not the browser. Interest is paid once a UTC day, simple, into the person's main balance in the pool's
 * own asset, out of the pool's reserve that the bank funds (`earn-service.ts`, `interest.ts`): those are facts of the
 * code, not settings. No owner table exists for balance-band rates, a commission on interest or a pool capacity, so each
 * reads null and the page says "not set"; a pool never shows zero for a figure nobody published.
 */
const poolFacts = {
  payoutEvery: z.literal('day'),
  compounding: z.literal('simple'),
  rewardAssetId: z.string(),
  yieldSource: z.literal('pool_reserve'),
  rateBands: z.array(z.object({ from: amountString, rateBps: z.number().int() })).nullable(),
  commissionBps: z.number().int().nullable(),
  capacity: amountString.nullable(),
  /** Staking-style (BK-earn-04): days a saving taken back unbonds before it is paid back; null for no unbonding. */
  unbondingDays: z.number().int().nullable(),
};

function poolView(p: PoolRecord) {
  return {
    id: p.id,
    assetId: p.assetId,
    kind: p.kind,
    name: p.name,
    aprBps: p.aprBps,
    termDays: p.termDays,
    minDeposit: formatAmount(p.minDeposit),
    payoutEvery: 'day' as const,
    compounding: 'simple' as const,
    rewardAssetId: p.assetId,
    yieldSource: 'pool_reserve' as const,
    rateBands: null,
    commissionBps: null,
    capacity: null,
    unbondingDays: p.unbondingDays,
  };
}

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
            ...poolFacts,
          }),
        ),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const pools = await bank.earn.listPools(input.assetId, input.limit);
          return pools.map(poolView);
        }),
      ),

    /** One pool by id, open or closed, with what it publishes (BK-earn-02, BK-earn-05): the pool's own page. */
    pool: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ poolId: z.string().guid() }))
      .output(
        z.object({
          id: z.string(),
          assetId: z.string(),
          kind: z.enum(['flexible', 'fixed']),
          name: z.string(),
          aprBps: z.number().int(),
          termDays: z.number().int().nullable(),
          minDeposit: amountString,
          status: z.enum(['open', 'closed']),
          /** How many approved status changes the pool has had (BK-earn-04). */
          statusRevision: z.number().int(),
          ...poolFacts,
        }),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const pool = await bank.earn.pool(input.poolId);
          return { ...poolView(pool), status: pool.status, statusRevision: pool.statusRevision };
        }),
      ),

    /**
     * The owner's risk wording for staking-style pools (BK-earn-04): what slashing means. Blank refuses
     * `bank.earn_risk_wording_unset`, and the pool page says it is not published, never that there is no risk.
     */
    riskDisclosure: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ slashing: z.string(), ownership: z.string() }))
      .query(async () => guard(async () => bank.earn.riskDisclosure())),

    /**
     * Every rate the pool has published, oldest first, as the bank recorded it (BK-earn-05, J-bank-08 #1). Nothing before
     * the first record is filled in: `earlier` says older records exist beyond this page, and an empty list means the
     * pool has no recorded change.
     */
    rateHistory: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          poolId: z.string().guid(),
          /** Page size. Optional so omit reaches `bank.earn_rate_history_limit_unset`; blank is not 50. */
          limit: z.number().int().min(1).max(200).optional(),
          /** Older records only: the effective time of the oldest record of the page before (exclusive). */
          before: z.string().datetime({ offset: true }).optional(),
        }),
      )
      .output(
        z.object({
          poolId: z.string(),
          currentBps: z.number().int(),
          changes: z.array(z.object({ rateBps: z.number().int(), effectiveAt: z.string(), reason: z.string().nullable() })),
          earlier: z.boolean(),
        }),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const history = await bank.earn.rateHistory(input.poolId, input.limit, input.before ? new Date(input.before) : undefined);
          return {
            ...history,
            changes: history.changes.map((c) => ({ rateBps: c.rateBps, effectiveAt: c.effectiveAt.toISOString(), reason: c.reason })),
          };
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

    /**
     * Take a saving back. In a staking-style pool (BK-earn-04) the first take back starts the unbonding and moves no
     * money: it needs `unbond: true`, and the answer says `unbonding` and when it ends. The bank releases the saving
     * when it ends; a take back from then on pays it back at once.
     */
    withdraw: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ positionId: z.string().guid(), unbond: z.boolean().optional() }))
      .output(
        z.object({
          positionId: z.string(),
          principal: amountString,
          status: z.enum(['closed', 'unbonding']),
          unbondsAt: z.string().nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const existing = await bank.earn.position(input.positionId);
          assertSelf(ctx.principal.userId, existing.userId);
          const after = await bank.earn.withdraw(input.positionId, new Date(), { unbond: input.unbond === true });
          return {
            positionId: after.id,
            principal: formatAmount(after.principal),
            status: after.status === 'closed' ? ('closed' as const) : ('unbonding' as const),
            unbondsAt: after.unbondsAt?.toISOString() ?? null,
          };
        }),
      ),

    /**
     * A fixed-term saving's auto-renew choice (BK-earn-03, J-bank-08 #4): on, a new term of the same length and amount
     * starts when this one ends; off, the saving can be taken back once the term ends.
     */
    setAutoRenew: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ positionId: z.string().guid(), on: z.boolean() }))
      .output(z.object({ positionId: z.string(), autoRenew: z.boolean(), maturesAt: z.string().nullable() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const existing = await bank.earn.position(input.positionId);
          assertSelf(ctx.principal.userId, existing.userId);
          const position = await bank.earn.setAutoRenew(input.positionId, input.on);
          return { positionId: position.id, autoRenew: position.autoRenew, maturesAt: position.maturesAt?.toISOString() ?? null };
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
            /** One pool's positions only (the pool page, BK-earn-05). */
            poolId: z.string().guid().optional(),
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
            openedAt: z.string(),
            maturesAt: z.string().nullable(),
            /** The pool's recorded rate when the position opened; null when it opened before the pool's first record. */
            rateAtOpenBps: z.number().int().nullable(),
            /** The UTC midnight the position first earns from: a day pays positions opened before it began. */
            accruesFrom: z.string(),
            /**
             * `waiting` until that day, then `accruing`, in an open or a closed pool; `unbonding` once a staking-style
             * saving is asked back (BK-earn-04); a too-small saving is paid nothing (BK-earn-01).
             */
            accrual: z.enum(['waiting', 'accruing', 'unbonding', 'below_unit']),
            /** A fixed-term saving the saver asked to renew when its term ends (BK-earn-03). */
            autoRenew: z.boolean(),
            /** How many new terms auto-renew has started; `maturesAt` is the end of the current one. */
            renewals: z.number().int(),
            /** The next UTC day the bank pays this saving's interest (a date); null when no day pays it. */
            nextPayoutOn: z.string().nullable(),
            /** Staking-style pools only (BK-earn-04): `staked`, `unbonding` or `unbonded`, by the bank's clock. */
            staking: z.enum(['staked', 'unbonding', 'unbonded']).nullable(),
            unbondingStartedAt: z.string().nullable(),
            unbondsAt: z.string().nullable(),
            /** The pool's unbonding period (BK-earn-04): taking this saving back starts it. Null: paid back at once. */
            unbondingDays: z.number().int().nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const positions = input?.poolId
            ? await bank.earn.positionsInPool(ctx.principal.userId, input.poolId, input.limit)
            : await bank.earn.positionsOf(ctx.principal.userId, input?.limit);
          const [atOpen, states] = await Promise.all([bank.earn.ratesAtOpen(positions), bank.earn.accrualStates(positions)]);
          return positions.map((p) => ({
            id: p.id,
            poolId: p.poolId,
            assetId: p.assetId,
            principal: formatAmount(p.principal),
            openedAt: p.openedAt.toISOString(),
            maturesAt: p.maturesAt?.toISOString() ?? null,
            rateAtOpenBps: atOpen.get(p.id) ?? null,
            accruesFrom: states.get(p.id)!.accruesFrom.toISOString(),
            accrual: states.get(p.id)!.accrual,
            autoRenew: p.autoRenew,
            renewals: states.get(p.id)!.renewals,
            nextPayoutOn: states.get(p.id)!.nextPayoutOn,
            staking: states.get(p.id)!.staking,
            unbondingStartedAt: p.unbondingStartedAt?.toISOString() ?? null,
            unbondsAt: p.unbondsAt?.toISOString() ?? null,
            unbondingDays: states.get(p.id)!.unbondingDays,
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
