import { defineProcedure } from './procedure.js';
import { distributionsMineInputSchema, distributionsMineSchema } from './campaigns-distribution.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `distribution.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

/**
 * The caller's own distributions (J-campaigns-13 #1 #2 #3): each airdrop they joined, how they stood at its snapshot,
 * their share and the chain transaction that paid it. Dividends refuse `owner.decision` naming the question.
 */
export const CAMPAIGNS_DISTRIBUTION_MINE = defineProcedure({
  ...base,
  name: 'campaigns.distribution.mine',
  kind: 'query',
  path: 'distribution.mine',
  access: { caller: 'scope', scope: 'campaigns:read', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: distributionsMineInputSchema,
  output: distributionsMineSchema,
  samples: [
    { verdict: 'accept', input: { kind: 'airdrop' } },
    { verdict: 'refuse', input: 42 },
  ],
});
