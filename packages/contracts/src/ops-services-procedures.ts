import { defineProcedure } from './procedure.js';
import { serviceGetInputSchema, serviceGetOutputSchema, serviceSetInputSchema } from './ops-console-services.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `services.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_SERVICES_GET = defineProcedure({
  ...base,
  name: 'ops.services.get',
  kind: 'query',
  path: 'services.get',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: serviceGetInputSchema,
  output: serviceGetOutputSchema,
  samples: [
    { verdict: 'accept', input: { module: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_SERVICES_SET = defineProcedure({
  ...base,
  name: 'ops.services.set',
  kind: 'mutation',
  path: 'services.set',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: serviceSetInputSchema,
  output: serviceGetOutputSchema,
  samples: [
    { verdict: 'accept', input: { module: 'USDC', expectedRevision: 0, ownerTeam: 'USDC', dependencies: [], runbook: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
