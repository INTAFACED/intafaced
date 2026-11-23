import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `totp.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_TOTP_ENROL = defineProcedure({
  ...base,
  name: 'identity.totp.enrol',
  kind: 'mutation',
  path: 'totp.enrol',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ secret: z.string(), uri: z.string(), recoveryCodes: z.array(z.string()) }),
  samples: [{ verdict: 'accept' }],
});
