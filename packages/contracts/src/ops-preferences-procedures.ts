import { defineProcedure, NO_INPUT } from './procedure.js';
import { preferencesSchema, preferencesSetInputSchema } from './ops-console-preferences.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `preferences.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_PREFERENCES_GET = defineProcedure({
  ...base,
  name: 'ops.preferences.get',
  kind: 'query',
  path: 'preferences.get',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.preferences_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: preferencesSchema,
  outputChecks: {
    time_zone_holds: {
      at: [
        'output.levels.server.values.timeZone',
        'output.levels.organisation.values.timeZone',
        'output.levels.team.values.timeZone',
        'output.levels.person.values.timeZone',
      ],
      says: 'not a time zone',
    },
  },
  samples: [{ verdict: 'accept' }],
});

export const OPS_PREFERENCES_SET = defineProcedure({
  ...base,
  name: 'ops.preferences.set',
  kind: 'mutation',
  path: 'preferences.set',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {
    'ops.preference_invalid': 'BAD_REQUEST',
    'ops.preferences_stale': 'CONFLICT',
    'ops.preferences_team_unassigned': 'BAD_REQUEST',
  },
  input: preferencesSetInputSchema,
  output: preferencesSchema,
  outputChecks: {
    time_zone_holds: {
      at: [
        'output.levels.server.values.timeZone',
        'output.levels.organisation.values.timeZone',
        'output.levels.team.values.timeZone',
        'output.levels.person.values.timeZone',
      ],
      says: 'not a time zone',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        level: 'organisation',
        expectedRevision: 0,
        values: { theme: 'USDC', homePage: 'USDC', timeZone: 'USDC', weekStart: 'USDC' },
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
