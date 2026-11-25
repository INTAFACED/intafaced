import { defineProcedure, NO_INPUT } from './procedure.js';
import { limitDeskOutputSchema, limitRequestSchema, limitReviewInputSchema } from './api-rate-limits.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `apiLimitDesk.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_API_LIMIT_DESK_QUEUE = defineProcedure({
  ...base,
  name: 'identity.apiLimitDesk.queue',
  kind: 'query',
  path: 'apiLimitDesk.queue',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: NO_INPUT,
  output: limitDeskOutputSchema,
  outputChecks: {
    iso_instant_holds: {
      at: ['output.asOf', 'output.requests[].createdAt', 'output.requests[].reviewedAt', 'output.audit[].at'],
      says: 'ISO instant',
    },
  },
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_API_LIMIT_DESK_REVIEW = defineProcedure({
  ...base,
  name: 'identity.apiLimitDesk.review',
  kind: 'mutation',
  path: 'apiLimitDesk.review',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: limitReviewInputSchema,
  output: limitRequestSchema,
  outputChecks: { iso_instant_holds: { at: ['output.createdAt', 'output.reviewedAt'], says: 'ISO instant' } },
  samples: [
    { verdict: 'accept', input: { decision: 'grant', id: '11111111-1111-4111-8111-111111111111', grantedPerMinute: 1, reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
