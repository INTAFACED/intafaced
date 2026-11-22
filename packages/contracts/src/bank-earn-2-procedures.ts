import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `earn.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_EARN_DEPOSIT = defineProcedure({
  ...base,
  name: 'bank.earn.deposit',
  kind: 'mutation',
  path: 'earn.deposit',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ poolId: z.string().guid(), amount: amountString, positionId: z.string().guid() }),
  output: z.object({ positionId: z.string(), maturesAt: z.string().nullable() }),
  samples: [
    {
      verdict: 'accept',
      input: { poolId: '11111111-1111-4111-8111-111111111111', amount: '1', positionId: '11111111-1111-4111-8111-111111111111' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Take a saving back. In a staking-style pool (BK-earn-04) the first take back starts the unbonding and moves no
 * money: it needs `unbond: true`, and the answer says `unbonding` and when it ends. The bank releases the saving
 * when it ends; a take back from then on pays it back at once.
 */
export const BANK_EARN_WITHDRAW = defineProcedure({
  ...base,
  name: 'bank.earn.withdraw',
  kind: 'mutation',
  path: 'earn.withdraw',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ positionId: z.string().guid(), unbond: z.boolean().optional() }),
  output: z.object({
    positionId: z.string(),
    principal: amountString,
    status: z.enum(['closed', 'unbonding']),
    unbondsAt: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { positionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
