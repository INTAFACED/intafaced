import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { SAME_PERSON_ACTION_TYPES } from './action-approval.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `stepUp.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const amountField = z.string().regex(/^\d+(\.\d{1,18})?$/);

export const beginInput = z
  .object({
    scope: z.enum(SAME_PERSON_ACTION_TYPES),
    purpose: z.string().min(1).max(64),
    amount: amountField.optional(),
    target: z.string().min(1).max(256).optional(),
    fields: z.record(z.string().min(1).max(64), z.string().max(4000)),
  })
  .strict();

export const ceremonyOutput = z.object({
  challengeId: z.string().guid(),
  expiresAt: z.string().datetime({ offset: true }),
  scope: z.string(),
  purpose: z.string(),
  amount: z.string().nullable(),
  target: z.string().nullable(),
  totp: z.boolean(),
  webauthn: z
    .object({
      challenge: z.string(),
      timeout: z.number(),
      rpId: z.string(),
      allowCredentials: z.array(
        z.object({
          type: z.literal('public-key'),
          id: z.string(),
          transports: z.array(z.string()).optional(),
        }),
      ),
      userVerification: z.literal('required'),
    })
    .nullable(),
});

/**
 * Start a confirmation for one payment. Returns a passkey challenge when
 * the account has a passkey, and `totp: true` when a six-digit code will
 * be accepted. Recovery codes are not a method. The result is not an
 * approval and not an access token.
 */
export const IDENTITY_STEP_UP_BEGIN = defineProcedure({
  ...base,
  name: 'identity.stepUp.begin',
  kind: 'mutation',
  path: 'stepUp.begin',
  access: { caller: 'signedIn' },
  refusals: {},
  input: beginInput,
  output: ceremonyOutput,
  samples: [
    { verdict: 'accept', input: { scope: 'bank.step_up.transfers.toUser', purpose: 'USDC', fields: {} } },
    { verdict: 'refuse', input: 42 },
  ],
});
