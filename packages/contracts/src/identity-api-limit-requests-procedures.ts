import { defineProcedure, NO_INPUT } from './procedure.js';
import { limitRequestCreateInputSchema, limitRequestListOutputSchema, limitRequestSchema } from './api-rate-limits.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `apiLimitRequests.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_API_LIMIT_REQUESTS_LIST_MINE = defineProcedure({
  ...base,
  name: 'identity.apiLimitRequests.listMine',
  kind: 'query',
  path: 'apiLimitRequests.listMine',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: limitRequestListOutputSchema,
  outputChecks: {
    iso_instant_holds: { at: ['output.asOf', 'output.requests[].createdAt', 'output.requests[].reviewedAt'], says: 'ISO instant' },
  },
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_API_LIMIT_REQUESTS_CREATE = defineProcedure({
  ...base,
  name: 'identity.apiLimitRequests.create',
  kind: 'mutation',
  path: 'apiLimitRequests.create',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: limitRequestCreateInputSchema,
  output: limitRequestSchema,
  outputChecks: { iso_instant_holds: { at: ['output.createdAt', 'output.reviewedAt'], says: 'ISO instant' } },
  samples: [
    {
      verdict: 'accept',
      input: {
        keyId: '11111111-1111-4111-8111-111111111111',
        askedPerMinute: 1,
        spikeStartsOn: '2026-01-01',
        spikeEndsOn: '2026-01-01',
        note: 'USDC',
        requestId: 'ethereum',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
