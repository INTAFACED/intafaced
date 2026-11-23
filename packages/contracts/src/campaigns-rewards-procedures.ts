import { defineProcedure } from './procedure.js';
import { myRewardsInputSchema, myRewardsSchema } from './campaigns-rewards.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `rewards.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

/** My Rewards hub: the caller's own rewards in plain status words, with totals summed from those rows. */
export const CAMPAIGNS_REWARDS_MINE = defineProcedure({
  ...base,
  name: 'campaigns.rewards.mine',
  kind: 'query',
  path: 'rewards.mine',
  access: { caller: 'scope', scope: 'campaigns:read', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: myRewardsInputSchema,
  output: myRewardsSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
