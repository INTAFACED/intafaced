import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountSchema, assetIdSchema, depositView } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `deposit.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/**
 * `admin:treasury`. WHY THAT SCOPE AND NOT ANOTHER.
 *
 * The test in `INTERACTIVE_ONLY_SCOPES` is "does this move value across
 * the platform boundary", and crediting a user from a rail boundary is
 * exactly that — inbound instead of outbound, but the same seam and the
 * same account. `admin:treasury` is already on that list, so this endpoint
 * inherits both halves of the protection for free: a long-lived API key
 * may never hold it (`assertKeyScopesAllowed`), and a session without a
 * second factor may not exercise it (`requireScope`).
 *
 * Identity consume is the third half: the MFA treasury session plus an
 * action-bound approval. A typed-in `confirmOperatorId` is not that.
 * Missing approval ids refuse. `creditedBy` stays the signed principal.
 *
 * The alternatives were all worse. `pay:write` is a MERCHANT scope that
 * ordinary integrations hold — it would let any merchant credit any user.
 * `admin:write` is broad, and not interactive-only, so a leaked operator
 * key could mint balances unattended. A new `ledger:credit` scope would be
 * a shared-package change (§15.2) to say something `admin:treasury`
 * already says.
 *
 * NO `{ module: 'pay' }` GUARD, deliberately. The jurisdiction matrix
 * judges THE USER BEING SERVED, and the principal here is an operator who
 * is not the beneficiary — running `checkAccess` against the operator's own
 * tier and region would be a check that measures the wrong person and
 * passes or fails for reasons that have nothing to do with the deposit.
 *
 * AND THE BENEFICIARY IS NOT TIER-GATED EITHER. Money that has already
 * arrived at a rail must always be bookable. Refusing to credit an
 * unverified user does not undo their payment; it strands it at the
 * boundary, which is the worst outcome in custody. The gate belongs on
 * what a balance can DO — `orders.create` needs `basic`, and the
 * withdrawal below is gated — not on being allowed to receive one.
 */
export const PAY_DEPOSIT_CREDIT = defineProcedure({
  ...base,
  name: 'pay.deposit.credit',
  kind: 'mutation',
  path: 'deposit.credit',
  access: { caller: 'scope', scope: 'admin:treasury' },
  refusals: {},
  input: z.object({
    userId: z.string().guid(),
    assetId: assetIdSchema,
    amount: amountSchema,
    railId: z.string().min(1),
    /** The rail's own reference. Half the business key, so it is required. */
    railRef: z.string().min(1).max(200),
    confirmOperatorId: z.string().max(128).nullish(),
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  }),
  output: depositView.extend({ confirmOperatorId: z.string() }),
  samples: [
    {
      verdict: 'accept',
      input: { userId: '11111111-1111-4111-8111-111111111111', assetId: 'USDC', amount: '1', railId: 'USDC', railRef: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
