import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { decideInputSchema, getInputSchema, listInputSchema, requestViewSchema } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `withdrawalApproval.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_WITHDRAWAL_APPROVAL_LIST = defineProcedure({
  ...base,
  name: 'pay.withdrawalApproval.list',
  kind: 'query',
  path: 'withdrawalApproval.list',
  access: { caller: 'scope', scope: 'trade:read', module: 'ledger' },
  refusals: {},
  input: listInputSchema,
  output: z.array(requestViewSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_WITHDRAWAL_APPROVAL_GET = defineProcedure({
  ...base,
  name: 'pay.withdrawalApproval.get',
  kind: 'query',
  path: 'withdrawalApproval.get',
  access: { caller: 'scope', scope: 'trade:read', module: 'ledger' },
  refusals: {},
  input: getInputSchema,
  output: requestViewSchema,
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_WITHDRAWAL_APPROVAL_CANCEL = defineProcedure({
  ...base,
  name: 'pay.withdrawalApproval.cancel',
  kind: 'mutation',
  path: 'withdrawalApproval.cancel',
  access: { caller: 'scope', scope: 'trade:write', module: 'ledger' },
  refusals: {},
  input: decideInputSchema,
  output: requestViewSchema,
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
