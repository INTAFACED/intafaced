import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  accountArchiveProposalsSchema,
  accountTierListSchema,
  customerDetailDecisionInputSchema,
  customerDetailsResultSchema,
  accountClosureLookupInputSchema,
  accountClosureStateSchema,
  customerDetailsHistoryInputSchema,
  accountTierLookupInputSchema,
  accountTierStateSchema,
} from './account-controls.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `accountControls.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_ACCOUNT_CONTROLS_ARCHIVE_PROPOSALS = defineProcedure({
  ...base,
  name: 'identity.accountControls.archiveProposals',
  kind: 'query',
  path: 'accountControls.archiveProposals',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({}).strict(),
  output: accountArchiveProposalsSchema,
  outputChecks: { account_archive_proposals_holds: { at: 'output', says: 'No proposal without a dormancy period' } },
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_DETAILS_DECIDE = defineProcedure({
  ...base,
  name: 'identity.accountControls.detailsDecide',
  kind: 'mutation',
  path: 'accountControls.detailsDecide',
  access: { caller: 'signedIn' },
  refusals: {},
  input: customerDetailDecisionInputSchema,
  output: customerDetailsResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userId: '11111111-1111-4111-8111-111111111111',
        reviewId: '11111111-1111-4111-8111-111111111111',
        decision: 'pass',
        note: '11111111-1111-4111-8111-111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_TIERS = defineProcedure({
  ...base,
  name: 'identity.accountControls.tiers',
  kind: 'query',
  path: 'accountControls.tiers',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({}).strict(),
  output: accountTierListSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_CLOSURE_STATE = defineProcedure({
  ...base,
  name: 'identity.accountControls.closureState',
  kind: 'query',
  path: 'accountControls.closureState',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountClosureLookupInputSchema,
  output: accountClosureStateSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_DETAILS_HISTORY = defineProcedure({
  ...base,
  name: 'identity.accountControls.detailsHistory',
  kind: 'query',
  path: 'accountControls.detailsHistory',
  access: { caller: 'signedIn' },
  refusals: {},
  input: customerDetailsHistoryInputSchema,
  output: z.array(customerDetailsResultSchema),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_TIER_STATE = defineProcedure({
  ...base,
  name: 'identity.accountControls.tierState',
  kind: 'query',
  path: 'accountControls.tierState',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountTierLookupInputSchema,
  output: accountTierStateSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
