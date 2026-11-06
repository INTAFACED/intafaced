import { z } from 'zod';
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
  return { plans, accountFees };
}
