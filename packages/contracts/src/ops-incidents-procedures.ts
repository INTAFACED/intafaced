import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  incidentDetailSchema,
  incidentGetInputSchema,
  incidentListInputSchema,
  incidentListOutputSchema,
  incidentMetricsSchema,
} from './ops-incidents.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `incidents.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_INCIDENTS_LIST = defineProcedure({
  ...base,
  name: 'ops.incidents.list',
  kind: 'query',
  path: 'incidents.list',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: incidentListInputSchema,
  output: incidentListOutputSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_INCIDENTS_METRICS = defineProcedure({
  ...base,
  name: 'ops.incidents.metrics',
  kind: 'query',
  path: 'incidents.metrics',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: incidentMetricsSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_INCIDENTS_GET = defineProcedure({
  ...base,
  name: 'ops.incidents.get',
  kind: 'query',
  path: 'incidents.get',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: incidentGetInputSchema,
  output: incidentDetailSchema,
  samples: [
    { verdict: 'accept', input: { incidentId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
