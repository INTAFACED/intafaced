import { defineProcedure, NO_INPUT } from './procedure.js';
import { campaignCatalogueSchema, campaignGetInputSchema, campaignViewSchema } from './campaigns-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `catalogue.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

/** The type list, parked types with their blocker, and every published campaign with the caller's own participation. */
export const CAMPAIGNS_CATALOGUE_LIST = defineProcedure({
  ...base,
  name: 'campaigns.catalogue.list',
  kind: 'query',
  path: 'catalogue.list',
  access: { caller: 'scope', scope: 'campaigns:read', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: campaignCatalogueSchema,
  outputChecks: { tier_id_holds: { at: 'output.campaigns[].trialPass.tierId', says: 'a pass grants a tier above regular' } },
  samples: [{ verdict: 'accept' }],
});

export const CAMPAIGNS_CATALOGUE_GET = defineProcedure({
  ...base,
  name: 'campaigns.catalogue.get',
  kind: 'query',
  path: 'catalogue.get',
  access: { caller: 'scope', scope: 'campaigns:read', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: campaignGetInputSchema,
  output: campaignViewSchema,
  outputChecks: { tier_id_holds: { at: 'output.trialPass.tierId', says: 'a pass grants a tier above regular' } },
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
