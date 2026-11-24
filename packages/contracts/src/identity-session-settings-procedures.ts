import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { settingsOut } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `sessionSettings.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_SESSION_SETTINGS = defineProcedure({
  ...base,
  name: 'identity.sessionSettings',
  kind: 'query',
  path: 'sessionSettings',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: settingsOut,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
