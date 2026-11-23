import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { tokenAmountSchema as amountString } from './token-governance.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-token `distributeRevenue.*`, one record per call: svc-token mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-token', module: 'token', transport: 'trpc' } as const;

export const TOKEN_DISTRIBUTE_REVENUE = defineProcedure({
  ...base,
  name: 'token.distributeRevenue',
  kind: 'mutation',
  path: 'distributeRevenue',
  access: { caller: 'scope', scope: 'admin:treasury' },
  refusals: {
    'action_approval.consume_failed': 'PRECONDITION_FAILED',
    'action_approval.missing': 'PRECONDITION_FAILED',
    'token.yield_source_underfunded': 'BAD_REQUEST',
  },
  input: z.object({
    windowId: z.string().min(1).max(128),
    sources: z
      .array(
        z.object({
          module: z.string().min(1).max(64),
          amount: amountString,
        }),
      )
      .min(1),
    /**
     * Typed-in second name is not approval. Nullish so MFA runs first;
     * missing/blank refuse `action_approval.missing`, not a schema dump.
     */
    confirmOperatorId: z.string().max(128).nullish(),
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  }),
  output: z.object({
    windowId: z.string(),
    /** Value moved BY THIS CALL. A re-run that posts nothing reports 0. */
    distributed: amountString,
    recipients: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    /**
     * Planned payouts this call found already posted — the operator's only
     * way to tell "this window was already settled" from "this window has
     * just paid out again", which the previous shape could not express.
     */
    alreadyPaid: z.number().int().nonnegative(),
    confirmOperatorId: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { windowId: 'USDC', sources: [{ module: 'USDC', amount: '1' }] } },
    { verdict: 'refuse', input: 42 },
  ],
});
