import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { authenticationOptions, registrationOptions } from './identity-call-schemas.js';

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

export const IDENTITY_WEBAUTHN_AUTH_OPTIONS = defineProcedure({
  ...base,
  name: 'identity.webauthn.authOptions',
  kind: 'mutation',
  path: 'webauthn.authOptions',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ identifier: z.string().min(1) }),
  output: authenticationOptions,
  samples: [
    { verdict: 'accept', input: { identifier: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_WEBAUTHN_REGISTER_OPTIONS = defineProcedure({
  ...base,
  name: 'identity.webauthn.registerOptions',
  kind: 'mutation',
  path: 'webauthn.registerOptions',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: registrationOptions,
  samples: [{ verdict: 'accept' }],
});

/** Limit required — omit never dumps credentials. */
export const IDENTITY_WEBAUTHN_LIST = defineProcedure({
  ...base,
  name: 'identity.webauthn.list',
  kind: 'query',
  path: 'webauthn.list',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(200) }),
  output: z.array(
    z.object({
      credentialId: z.string(),
      createdAt: z.string(),
      transports: z.array(z.string()).optional(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
