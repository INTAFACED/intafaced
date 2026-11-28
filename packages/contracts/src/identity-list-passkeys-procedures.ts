import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/**
 * Passkeys bound to a purpose, and a passkey as the second step after the password (I-signin-sessions-10).
 *
 * A passkey may be bound to any of three purposes: `signin` (the second step after the password, and passkey sign-in),
 * `money_out` (confirming money leaving the account) and `security_change` (confirming a change to how the account
 * signs in or is secured). The last two are the floor actions of the Security checklist (factor-status.ts). The
 * binding lives on the credential itself in `users.webauthn_creds` (`purposes`), so every passkey writer already
 * holds the users row lock that guards it.
 *
 * For one purpose, the passkeys bound to it are the only ones offered and the only ones accepted. When none is bound to
 * it, the passkeys bound to nothing answer, so a passkey kept for signing in does not confirm money out; with no
 * purposes set anywhere every passkey works, as before.
 */
export const PASSKEY_PURPOSES = ['signin', 'money_out', 'security_change'] as const;

export const row = z.object({
  credentialId: z.string(),
  label: z.string().nullable(),
  kind: z.enum(['platform', 'cross_device', 'security_key', 'unknown']),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  purposes: z.array(z.enum(PASSKEY_PURPOSES)),
});

export const IDENTITY_LIST_PASSKEYS = defineProcedure({
  ...base,
  name: 'identity.listPasskeys',
  kind: 'query',
  path: 'listPasskeys',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(200) }).strict(),
  output: z.object({ passkeys: z.array(row), maxPerAccount: z.number().int().nullable(), secondStep: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
