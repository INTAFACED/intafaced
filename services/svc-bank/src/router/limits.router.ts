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
  /**
   * J-wallet-01 #3: what a partner-held person can withdraw from their main balance at the partner, and what the partner
   * still holds back of their purchases, with each hold's release time and each release once. Every figure is the
   * partner's. A partner that does not report its holds is `reported: false`: what is held back, and so what can be
   * withdrawn, is "not reported by the partner", never 0. `held: false` is a person the partner holds no money for.
   */
  const hold = z.object({
    id: z.string(),
    assetId: z.string(),
    amount: z.string(),
    paidBy: z.enum(['card', 'bank_pull']),
    releaseAt: z.string(),
  });
  const partnerHolds = scopedProcedure('bank:read', { module: 'bank' })
    .output(
      z.discriminatedUnion('held', [
        z.object({ held: z.literal(false) }),
        z.object({
          held: z.literal(true),
          label: z.string(),
          reported: z.boolean(),
          asOf: z.string().nullable(),
          balances: z.array(
            z.object({
              assetId: z.string(),
              balance: z.string().nullable(),
              balanceAsOf: z.string().nullable(),
              heldBack: z.string().nullable(),
              withdrawable: z.string().nullable(),
            }),
          ),
          holds: z.array(hold),
          released: z.array(hold.extend({ releasedAt: z.string() })),
        }),
      ]),
    )
    .query(({ ctx }) =>
      guard(async () => {
        const userId = ctx.principal.userId;
        const partner = bank.partnerCustody.bankFor(userId);
        const purchases = bank.partnerPurchases.purchasesFor(userId);
        if (!partner || !purchases) return { held: false as const };
        const [report, balances] = await Promise.all([purchases.holds(userId), partner.balances(userId)]);
        const holdView = (h: { id: string; assetId: string; amount: bigint; paidBy: 'card' | 'bank_pull'; releaseAt: Date }) => ({
          id: h.id,
          assetId: h.assetId,
          amount: formatAmount(h.amount),
          paidBy: h.paidBy,
          releaseAt: h.releaseAt.toISOString(),
        });
        const holds = report.reported ? report.holds : [];
        return {
          held: true as const,
          label: report.label,
          reported: report.reported,
          asOf: report.reported ? report.asOf.toISOString() : null,
          balances: balances
            .filter((b) => b.account.spaceId === null)
            .map((b) => {
              const known = b.amount !== null && b.asOf !== null ? b.amount : null;
              const back = report.reported
                ? holds.filter((h) => h.assetId === b.account.assetId).reduce((sum, h) => sum + h.amount, 0n)
                : null;
              return {
                assetId: b.account.assetId,
                balance: known === null ? null : formatAmount(known),
                balanceAsOf: b.asOf?.toISOString() ?? null,
                heldBack: back === null ? null : formatAmount(back),
                withdrawable: known === null || back === null ? null : formatAmount(known > back ? known - back : 0n),
              };
            }),
          holds: holds.map(holdView),
          released: report.reported ? report.released.map((r) => ({ ...holdView(r), releasedAt: r.releasedAt.toISOString() })) : [],
        };
      }),
    );
  return { plans, accountFees, partnerLimits, partnerHolds, dormancy };
}
