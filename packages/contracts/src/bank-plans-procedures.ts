import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { plan } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `plans.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** The plans on offer and the person's own; blank refuses `bank.plans_unset`. A paid plan names `bank.plan_fee_unwired`. */
export const BANK_PLANS_LIST = defineProcedure({
  ...base,
  name: 'bank.plans.list',
  kind: 'query',
  path: 'plans.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ plans: z.array(plan.extend({ blocker: z.literal('bank.plan_fee_unwired').nullable() })), current: plan }),
  samples: [{ verdict: 'accept' }],
});
