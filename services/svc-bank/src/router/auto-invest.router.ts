import { z } from 'zod';
import { router, publicProcedure, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { describeAutoInvestPolicy } from '../auto-invest/auto-invest-policy.js';
import { amountString } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createAutoInvestRouter(c: BankRouterContext) {
  const { bank, autoInvestEnabled, autoInvestConvertWired } = c;
  const autoInvestRuleOutput = z.object({
    id: z.string(),
    kind: z.enum(['threshold_sweep', 'dca', 'card_roundup']),
    assetId: z.string(),
    threshold: amountString.nullable(),
    targetPoolId: z.string().nullable(),
    targetSpaceId: z.string().nullable(),
    buyAssetId: z.string().nullable(),
    amount: amountString.nullable(),
    cadence: z.enum(['daily', 'weekly', 'monthly']).nullable(),
    nextRunAt: z.string().nullable(),
    status: z.enum(['active', 'paused', 'cancelled']),
    createdAt: z.string(),
  });

  function mapRule(r: Awaited<ReturnType<typeof bank.autoInvest.listRules>>[number]) {
    return {
      id: r.id,
      kind: r.kind,
      assetId: r.assetId,
      threshold: r.threshold === null ? null : formatAmount(r.threshold),
      targetPoolId: r.targetPoolId,
      targetSpaceId: r.targetSpaceId,
      buyAssetId: r.buyAssetId,
      amount: r.amount === null ? null : formatAmount(r.amount),
      cadence: r.cadence,
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    };
  }

  return router({
    policy: publicProcedure.query(() => describeAutoInvestPolicy({ enabled: autoInvestEnabled, convertWired: autoInvestConvertWired })),

    /**
     * List this user's auto-invest rules. Rules hold no balance — they are
     * instructions; the ledger answers "how much".
     */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.auto_invest_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
            /** Only the round-ups into this one of the caller's own spaces (BK-pots-02). */
            targetSpaceId: z.string().guid().optional(),
          })
          .optional(),
      )
      .output(z.array(autoInvestRuleOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await (input?.targetSpaceId
            ? bank.autoInvest.listRules(ctx.principal.userId, input.limit, { targetSpaceId: input.targetSpaceId })
            : bank.autoInvest.listRules(ctx.principal.userId, input?.limit));
          return rows.map(mapRule);
        }),
      ),

    /**
     * Same-asset threshold sweep: keep `threshold` in primary available; move
     * excess into an earn pool of the same asset. No rate is consulted.
     */
    createThresholdSweep: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          threshold: amountString,
          targetPoolId: z.string().guid(),
        }),
      )
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.createThresholdSweep({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            threshold: parseAmount(input.threshold),
            targetPoolId: input.targetPoolId,
          });
          return mapRule(rule);
        }),
      ),

    /**
     * Card round-up. Same-asset spare change → an earn pool, or one of the caller's own named spaces (BK-pots-02), on
     * capture. Exactly one of `targetPoolId` and `targetSpaceId`, else `bank.auto_invest_target_invalid`.
     * `buyAssetId` that differs from `assetId` refuses `bank.auto_invest_rate_unset`
     * — the surface exists so the dishonest half is named, not silent.
     */
    createRoundUp: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          granularity: amountString,
          targetPoolId: z.string().guid().optional(),
          targetSpaceId: z.string().guid().optional(),
          buyAssetId: z.string().min(1).max(16).optional(),
        }),
      )
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.createCardRoundUp({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            granularity: parseAmount(input.granularity),
            ...(input.targetPoolId ? { targetPoolId: input.targetPoolId } : {}),
            ...(input.targetSpaceId ? { targetSpaceId: input.targetSpaceId } : {}),
            ...(input.buyAssetId ? { buyAssetId: input.buyAssetId } : {}),
          });
          return mapRule(rule);
        }),
      ),

    /**
     * DCA schedule. Refuses `bank.auto_invest_rate_unset` when this deployment
     * has no convert counterparty — §8 rates are never invented here.
     */
    createDca: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          spendAssetId: z.string().min(1).max(16),
          buyAssetId: z.string().min(1).max(16),
          amount: amountString,
          cadence: z.enum(['daily', 'weekly', 'monthly']),
          startsAt: z.string().datetime({ offset: true }),
        }),
      )
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.createDca({
            userId: ctx.principal.userId,
            spendAssetId: input.spendAssetId,
            buyAssetId: input.buyAssetId,
            amount: parseAmount(input.amount),
            cadence: input.cadence,
            startsAt: new Date(input.startsAt),
          });
          return mapRule(rule);
        }),
      ),

    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ ruleId: z.string().guid() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.getRule(input.ruleId);
          if (rule.userId !== ctx.principal.userId) {
            throw new BankError('Not your auto-invest rule', 'bank.not_owner');
          }
          await bank.autoInvest.cancelRule(input.ruleId);
          return { ok: true as const };
        }),
      ),

    /**
     * Hold a rule without cancelling. Runner only considers `active` rules.
     */
    pause: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ ruleId: z.string().guid() }))
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.getRule(input.ruleId);
          if (rule.userId !== ctx.principal.userId) {
            throw new BankError('Not your auto-invest rule', 'bank.not_owner');
          }
          return mapRule(await bank.autoInvest.pauseRule(input.ruleId));
        }),
      ),

    /**
     * Resume a paused rule. Next runDue pass applies normal due rules — no
     * multi-fire invent of missed windows.
     */
    resume: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ ruleId: z.string().guid() }))
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.getRule(input.ruleId);
          if (rule.userId !== ctx.principal.userId) {
            throw new BankError('Not your auto-invest rule', 'bank.not_owner');
          }
          return mapRule(await bank.autoInvest.resumeRule(input.ruleId));
        }),
      ),
  });
}
