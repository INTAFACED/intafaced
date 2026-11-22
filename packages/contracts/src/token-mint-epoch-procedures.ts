import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { tokenAmountSchema as amountString } from './token-governance.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-token `mintEpoch.*`, one record per call: svc-token mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-token', module: 'token', transport: 'trpc' } as const;

export const TOKEN_MINT_EPOCH = defineProcedure({
  ...base,
  name: 'token.mintEpoch',
  kind: 'mutation',
  path: 'mintEpoch',
  access: { caller: 'service', callers: ['svc-token'], forbidden: 'token job is callable only as svc-token' },
  refusals: {},
  input: z.object({ epoch: z.number().int().nonnegative().optional() }).default({}),
  output: z.object({ epoch: z.number().int(), minted: amountString }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
