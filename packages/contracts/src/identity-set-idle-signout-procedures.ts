import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { settingsOut } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `setIdleSignout.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/**
 * Sets this account's own idle sign-out, or clears it (null) back to the owner's. Never longer than the owner's and never
 * shorter than one access token's life: either refuses with `identity.session_setting_out_of_range` and changes nothing.
 * No step-up: the owner's setting still bounds every value, so no choice here can keep a sign-in longer than the owner allows.
 */
export const IDENTITY_SET_IDLE_SIGNOUT = defineProcedure({
  ...base,
  name: 'identity.setIdleSignout',
  kind: 'mutation',
  path: 'setIdleSignout',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ seconds: z.number().int().nullable() }).strict(),
  output: settingsOut,
  samples: [
    { verdict: 'accept', input: { seconds: -9007199254740991 } },
    { verdict: 'refuse', input: 42 },
  ],
});
