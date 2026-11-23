import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { tgeClaimInputSchema } from './campaigns-drops.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `tge.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

/** Always refuses by name and posts nothing: mainnet waits for the external audit, testnet for the schedule. */
export const CAMPAIGNS_TGE_CLAIM = defineProcedure({
  ...base,
  name: 'campaigns.tge.claim',
  kind: 'mutation',
  path: 'tge.claim',
  access: { caller: 'scope', scope: 'campaigns:write', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: tgeClaimInputSchema,
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { network: 'testnet' } },
    { verdict: 'refuse', input: 42 },
  ],
});
