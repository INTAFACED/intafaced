import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `webauthn.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/**
 * Retire one enrolled authenticator. Self-only via principal.
 * Missing/foreign id → removed:false (never confirms existence).
 */
export const IDENTITY_WEBAUTHN_REMOVE = defineProcedure({
  ...base,
  name: 'identity.webauthn.remove',
  kind: 'mutation',
  path: 'webauthn.remove',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ credentialId: z.string().min(1) }),
  output: z.object({ removed: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { credentialId: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
