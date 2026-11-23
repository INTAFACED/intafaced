import { defineProcedure, NO_INPUT } from './procedure.js';
import { myCampaignsSchema } from './campaigns-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `participation.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

export const CAMPAIGNS_PARTICIPATION_MINE = defineProcedure({
  ...base,
  name: 'campaigns.participation.mine',
  kind: 'query',
  path: 'participation.mine',
  access: { caller: 'scope', scope: 'campaigns:read', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: myCampaignsSchema,
  outputChecks: { tier_id_holds: { at: 'output.campaigns[].campaign.trialPass.tierId', says: 'a pass grants a tier above regular' } },
  samples: [{ verdict: 'accept' }],
});
