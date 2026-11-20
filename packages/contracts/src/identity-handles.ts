/**
 * Who someone is on INTAFACED, as svc-identity answers it, one record per call: the caller's own handle (`me`), an exact
 * @handle lookup (`users.resolveHandle`), the payee card (`users.payeeCard`) and signed pay codes (`qr.mine`,
 * `qr.resolve`). svc-identity mounts each from here. Browser-safe (zod only).
 */
import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;
const USER = '11111111-1111-4111-8111-111111111111';

export const HANDLE_LOOKUP_RATE_LIMITED = 'identity.handle_lookup_rate_limited';
/** Longest pay code accepted: `v1.` + 36 + `.` + 16 + `.` + 43. Anything longer is refused without parsing; `qr.resolve` takes up to twice that before refusing it as malformed. */
export const PAY_QR_PAYLOAD_MAX = 100;

/** The caller's own account: self-only, the user id comes from the session. A session for an account that is gone answers UNAUTHORIZED. */
export const IDENTITY_ME = defineProcedure({
  ...base,
  name: 'identity.me',
  kind: 'query',
  path: 'me',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ userId: z.string().guid(), handle: z.string(), emailVerified: z.boolean() }),
  samples: [{ verdict: 'accept' }],
});

/**
 * Pay by exact @handle: the stored handle, the user id a transfer needs, and `self`. Malformed, unknown, frozen, closed
 * and undiscoverable handles all answer `{ found: false }`. A per-caller budget refuses bulk probing; an API key is
 * refused (FORBIDDEN, unnamed).
 */
export const IDENTITY_USERS_RESOLVE_HANDLE = defineProcedure({
  ...base,
  name: 'identity.users.resolveHandle',
  kind: 'query',
  path: 'users.resolveHandle',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: { [HANDLE_LOOKUP_RATE_LIMITED]: 'TOO_MANY_REQUESTS' },
  input: z.object({ handle: z.string().max(64) }),
  output: z.discriminatedUnion('found', [
    z.object({ found: z.literal(false) }),
    z.object({ found: z.literal(true), userId: z.string().guid(), handle: z.string(), self: z.boolean() }),
  ]),
  samples: [
    { verdict: 'accept', input: { handle: 'luffy2' } },
    { verdict: 'refuse', input: { handle: 'x'.repeat(65) } },
  ],
});

/**
 * Find a person by exact email or exact phone: the same answers and the same budget as `resolveHandle` (its 429 and an
 * API key's 403 carry no code). A hit needs that person's consent; the email and phone are never in the answer.
 */
export const IDENTITY_USERS_SEARCH_PAYEES = defineProcedure({
  ...base,
  name: 'identity.users.searchPayees',
  kind: 'query',
  path: 'users.searchPayees',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  checks: { emailOrPhone: { at: 'input', says: 'exactly one of email and phone is given' } },
  input: z
    .object({
      email: z.string().max(320).optional(),
      phone: z.string().max(32).optional(),
    })
    .strict()
    .refine((value) => (value.email !== undefined) !== (value.phone !== undefined), 'Send an email or a phone, not both'),
  output: IDENTITY_USERS_RESOLVE_HANDLE.output,
  samples: [
    { verdict: 'accept', input: { email: 'someone@example.test' } },
    { verdict: 'accept', input: { phone: '+447700900123' } },
    { verdict: 'refuse', input: { email: 'x'.repeat(321) } },
    { verdict: 'refuse', by: 'emailOrPhone', input: { email: 'someone@example.test', phone: '+447700900123' } },
  ],
});

/** The payee card for an account a lookup or pay code already named: the profile name (null when none) and the month they joined. */
export const IDENTITY_USERS_PAYEE_CARD = defineProcedure({
  ...base,
  name: 'identity.users.payeeCard',
  kind: 'query',
  path: 'users.payeeCard',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: z.object({ userId: z.string().guid() }),
  output: z.discriminatedUnion('found', [
    z.object({ found: z.literal(false) }),
    z.object({ found: z.literal(true), name: z.string().nullable(), memberSince: z.string().regex(/^\d{4}-\d{2}$/) }),
  ]),
  samples: [
    { verdict: 'accept', input: { userId: USER } },
    { verdict: 'refuse', input: { userId: 'not-a-guid' } },
  ],
});

/** How svc-identity sends each pay-code refusal. */
const PAY_QR_REFUSALS = {
  'identity.qr_key_unset': 'PRECONDITION_FAILED',
  'identity.delegated_refused': 'FORBIDDEN',
  'identity.qr_payee_unavailable': 'NOT_FOUND',
  'identity.qr_invalid': 'BAD_REQUEST',
} as const;
export type PayQrCode = keyof typeof PAY_QR_REFUSALS;
export const payQrRefusalStatus = (code: PayQrCode) => PAY_QR_REFUSALS[code];

/** The caller's own signed pay code, for their QR code and payment link. */
export const IDENTITY_QR_MINE = defineProcedure({
  ...base,
  name: 'identity.qr.mine',
  kind: 'query',
  path: 'qr.mine',
  access: { caller: 'signedIn' },
  refusals: {
    'identity.qr_key_unset': PAY_QR_REFUSALS['identity.qr_key_unset'],
    'identity.delegated_refused': PAY_QR_REFUSALS['identity.delegated_refused'],
    'identity.qr_payee_unavailable': PAY_QR_REFUSALS['identity.qr_payee_unavailable'],
  },
  input: NO_INPUT,
  output: z.object({ payload: z.string() }),
  samples: [{ verdict: 'accept' }],
});

/** Who a scanned code pays: their account id and handle, and whether it is the caller. */
export const IDENTITY_QR_RESOLVE = defineProcedure({
  ...base,
  name: 'identity.qr.resolve',
  kind: 'query',
  path: 'qr.resolve',
  access: { caller: 'signedIn' },
  refusals: PAY_QR_REFUSALS,
  input: z.object({
    payload: z
      .string()
      .min(1)
      .max(PAY_QR_PAYLOAD_MAX * 2),
  }),
  output: z.object({ userId: z.string(), handle: z.string(), self: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { payload: 'ifq1.sample' } },
    { verdict: 'refuse', input: { payload: '' } },
  ],
});

export const IDENTITY_HANDLES_PROCEDURES = [
  IDENTITY_ME,
  IDENTITY_USERS_RESOLVE_HANDLE,
  IDENTITY_USERS_SEARCH_PAYEES,
  IDENTITY_USERS_PAYEE_CARD,
  IDENTITY_QR_MINE,
  IDENTITY_QR_RESOLVE,
] as const;
