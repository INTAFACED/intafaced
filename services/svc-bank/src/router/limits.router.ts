import { z } from 'zod';
import { formatAmount } from '@intafaced/ledger-client';
import { router, scopedProcedure } from '@intafaced/contracts';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';
import { planView } from '../plans/plans.js';

/** BK-acct-04 (J-bank-16 #6): the owner's plan table and account fee table, read only. */
export function createLimitsRouters(c: BankRouterContext) {
  const { bank } = c;
  const plan = z.object({
    id: z.string(),
    name: z.string(),
    tier: z.string(),
    price: z.string(),
    assetId: z.string(),
    period: z.literal('month'),
  });
  const plans = router({
    /** The plans on offer and the person's own; blank refuses `bank.plans_unset`. A paid plan names `bank.plan_fee_unwired`. */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ plans: z.array(plan.extend({ blocker: z.literal('bank.plan_fee_unwired').nullable() })), current: plan }))
      .query(() =>
        guard(async () => {
          const view = planView(bank.accountTables.plans);
          return { plans: [...view.plans], current: view.current };
        }),
      ),
  });
  /** The owner's account fee table. None published is `set: false` and no lines: the page says "not set". */
  const accountFees = scopedProcedure('bank:read', { module: 'bank' })
    .output(
      z.object({
        set: z.boolean(),
        lines: z.array(z.object({ id: z.string(), label: z.string(), fee: z.string(), assetId: z.string() })),
      }),
    )
    .query(() => guard(async () => ({ set: bank.accountTables.fees !== null, lines: bank.accountTables.fees ?? [] })));
  /** RC-bank-01 (J-bank-16 #7): the owner's dormancy rules, and the person's own notices with how each was settled. */
  const dormancy = router({
    rules: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.array(
          z.object({
            assetId: z.string(),
            fee: z.string(),
            inactiveDays: z.number().int(),
            noticeLeadDays: z.number().int(),
            version: z.string(),
          }),
        ),
      )
      .query(() => guard(async () => bank.dormancy.published())),
    notices: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.array(
          z.object({
            assetId: z.string(),
            fee: z.string(),
            debitDate: z.string(),
            inactiveDays: z.number().int(),
            state: z.enum(['noticed', 'cancelled', 'skipped_zero', 'skipped_insufficient', 'charged']),
            partnerMoveId: z.string().nullable(),
            noticedAt: z.string(),
            settledAt: z.string().nullable(),
          }),
        ),
      )
      .query(({ ctx }) =>
        guard(async () =>
          (await bank.dormancy.notices(ctx.principal.userId)).map((n) => ({
            ...n,
            noticedAt: n.noticedAt.toISOString(),
            settledAt: n.settledAt?.toISOString() ?? null,
          })),
        ),
      ),
  });
  /** J-bank-16 #6: the partner's send limit and fee for a partner-held person; `held: false` is on our own terms. */
  const partnerLimits = scopedProcedure('bank:read', { module: 'bank' })
    .input(z.object({ assetId: z.string().min(1).max(16) }))
    .output(
      z.discriminatedUnion('held', [
        z.object({ held: z.literal(false) }),
        z.object({
          held: z.literal(true),
          label: z.string(),
          assetId: z.string(),
          dailyLimit: z.string().nullable(),
          usedToday: z.string().nullable(),
          remainingToday: z.string().nullable(),
          sendFee: z.string().nullable(),
          asOf: z.string().nullable(),
        }),
      ]),
    )
    .query(({ ctx, input }) =>
      guard(async () => {
        const partner = bank.partnerCustody.bankFor(ctx.principal.userId);
        if (!partner) return { held: false as const };
        const l = await partner.limits(ctx.principal.userId, input.assetId);
        const known = l.dailySend !== null && l.usedToday !== null;
        return {
          held: true as const,
          label: l.label,
          assetId: l.assetId,
          dailyLimit: l.dailySend === null ? null : formatAmount(l.dailySend),
          usedToday: l.usedToday === null ? null : formatAmount(l.usedToday),
          remainingToday: !known ? null : formatAmount(l.dailySend! > l.usedToday! ? l.dailySend! - l.usedToday! : 0n),
          sendFee: l.sendFee === null ? null : formatAmount(l.sendFee),
          asOf: l.asOf?.toISOString() ?? null,
        };
      }),
    );
  return { plans, accountFees, partnerLimits, dormancy };
}
