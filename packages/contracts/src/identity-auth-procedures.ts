import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { signInChallengeSchema, signInChallengeProofSchema } from './identity-signin-challenge.js';
import { loggedOutEverywhereSchema } from './identity-account-room.js';
import {
  ACCOUNT_TYPES,
  loginCodeAccepted,
  SELF_FREEZE_REASONS,
  sessionOutput,
  signUpAccepted,
  socialProviderName,
  authenticationOptions,
  walletChallengeInput,
  walletChallengeOutput,
  walletAnswerFields,
} from './identity-call-schemas.js';
import { jsonValueSchema } from './procedure-strict-schema.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `auth.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/**
 * A signed sign-in challenge (I-signin-sessions-30): the browser solves it and sends it as `challenge` on the next
 * `auth.login` once that answered `auth.challenge_required`. Says nothing about any account. Blank owner settings
 * refuse `identity.challenge_unconfigured`.
 */
export const IDENTITY_AUTH_CHALLENGE = defineProcedure({
  ...base,
  name: 'identity.auth.challenge',
  kind: 'mutation',
  path: 'auth.challenge',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: signInChallengeSchema,
  samples: [{ verdict: 'accept' }],
});

/**
 * New-device sign-in (I-signin-sessions-07), from the waiting browser: the code mailed to the account approves this
 * device and signs in at once. The flow's secret, which only that browser holds, proves it is the one asking. A
 * wrong code counts toward the owner's lockout.
 */
export const IDENTITY_AUTH_DEVICE_APPROVE = defineProcedure({
  ...base,
  name: 'identity.auth.deviceApprove',
  kind: 'mutation',
  path: 'auth.deviceApprove',
  access: { caller: 'public' },
  refusals: {},
  input: z
    .object({
      flowId: z.string().guid(),
      secret: z.string().min(16).max(128),
      code: z.string().trim().min(1).max(12),
      deviceKey: z.string().min(16).max(128).optional(),
    })
    .strict(),
  output: sessionOutput,
  samples: [
    { verdict: 'accept', input: { flowId: '11111111-1111-4111-8111-111111111111', secret: 'placeholderxxxxx', code: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * New-device sign-in, after a trusted session approved it: the waiting browser completes once with its secret.
 * Not approved yet answers `auth.device_authorisation_pending`; a second completion `auth.device_authorisation_used`.
 */
export const IDENTITY_AUTH_DEVICE_COMPLETE = defineProcedure({
  ...base,
  name: 'identity.auth.deviceComplete',
  kind: 'mutation',
  path: 'auth.deviceComplete',
  access: { caller: 'public' },
  refusals: {},
  input: z
    .object({ flowId: z.string().guid(), secret: z.string().min(16).max(128), deviceKey: z.string().min(16).max(128).optional() })
    .strict(),
  output: sessionOutput,
  samples: [
    { verdict: 'accept', input: { flowId: '11111111-1111-4111-8111-111111111111', secret: 'placeholderxxxxx' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Change the signed-in user's password. User sessions only (an API key or
 * sub-account is refused), the current password is required, and an account
 * with any second factor also needs an `mfa` session. Revokes every OTHER
 * session; the caller's stays. Rules: auth-service `changePassword`.
 */
export const IDENTITY_AUTH_CHANGE_PASSWORD = defineProcedure({
  ...base,
  name: 'identity.auth.changePassword',
  kind: 'mutation',
  path: 'auth.changePassword',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { currentPassword: 'placeholder', newPassword: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_AUTH_SELF_FREEZE_STATUS = defineProcedure({
  ...base,
  name: 'identity.auth.selfFreezeStatus',
  kind: 'query',
  path: 'auth.selfFreezeStatus',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ frozen: z.boolean(), reason: z.enum(SELF_FREEZE_REASONS).nullable(), since: z.string().nullable() }),
  samples: [{ verdict: 'accept' }],
});

/**
 * Self-service freeze (I-account-lifecycle-08). Needs the current password; revokes every session and key.
 * Not the staff freeze and not the ledger freeze.
 */
export const IDENTITY_AUTH_SELF_FREEZE = defineProcedure({
  ...base,
  name: 'identity.auth.selfFreeze',
  kind: 'mutation',
  path: 'auth.selfFreeze',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ reason: z.enum(SELF_FREEZE_REASONS), password: z.string().min(1).max(200) }),
  output: z.object({ frozen: z.literal(true), reason: z.enum(SELF_FREEZE_REASONS), since: z.string(), changed: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { reason: 'compromise', password: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Signed-in email confirmation, step 1. The link goes to this account's
 * own address. The response does not say whether a message was sent.
 * An API key is not a session.
 */
export const IDENTITY_AUTH_REQUEST_EMAIL_CONFIRMATION = defineProcedure({
  ...base,
  name: 'identity.auth.requestEmailConfirmation',
  kind: 'mutation',
  path: 'auth.requestEmailConfirmation',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ accepted: z.literal(true) }),
  samples: [{ verdict: 'accept' }],
});

/**
 * Sign-in by a mailed code, step 1 (I-signin-sessions-19, -20). Takes an email or handle and answers the same
 * for every name, with no session: only an active account is mailed a six-digit code.
 */
export const IDENTITY_AUTH_LOGIN_CODE_REQUEST = defineProcedure({
  ...base,
  name: 'identity.auth.loginCodeRequest',
  kind: 'mutation',
  path: 'auth.loginCodeRequest',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ identifier: z.string().trim().min(1).max(320) }),
  output: loginCodeAccepted,
  samples: [
    { verdict: 'accept', input: { identifier: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Sign-in by a mailed code, step 2: the right code opens one session. A wrong code counts toward the owner's
 * lockout, a used one is refused, and an account with an authenticator still answers `auth.mfa_required` until
 * its code comes too (the mailed code stays unspent meanwhile).
 */
export const IDENTITY_AUTH_LOGIN_WITH_CODE = defineProcedure({
  ...base,
  name: 'identity.auth.loginWithCode',
  kind: 'mutation',
  path: 'auth.loginWithCode',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({
    flowId: z.string().guid(),
    code: z.string().trim().min(1).max(12),
    totpCode: z.string().trim().min(1).max(64).optional(),
    deviceKey: z.string().min(16).max(128).optional(),
  }),
  output: sessionOutput,
  samples: [
    { verdict: 'accept', input: { flowId: '11111111-1111-4111-8111-111111111111', code: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Sign-in by a mailed code, step 1b: a new code once the resend interval has passed; the old one stops working. */
export const IDENTITY_AUTH_LOGIN_CODE_RESEND = defineProcedure({
  ...base,
  name: 'identity.auth.loginCodeResend',
  kind: 'mutation',
  path: 'auth.loginCodeResend',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ flowId: z.string().guid() }),
  output: loginCodeAccepted,
  samples: [
    { verdict: 'accept', input: { flowId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Email confirmation, step 2. The token is the proof. A link that ran out or was already used is refused by name
 * (the 256-bit token names no account); a wrong or rebound token is one refusal.
 */
export const IDENTITY_AUTH_CONFIRM_EMAIL = defineProcedure({
  ...base,
  name: 'identity.auth.confirmEmail',
  kind: 'mutation',
  path: 'auth.confirmEmail',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ token: z.string().trim().min(1).max(500) }),
  output: z.object({ confirmed: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { token: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Username recovery. Same shape and same answer as `requestPasswordReset`: the username is mailed to a
 * known address, and nothing in the answer says whether the address has an account.
 */
export const IDENTITY_AUTH_REQUEST_HANDLE_RECOVERY = defineProcedure({
  ...base,
  name: 'identity.auth.requestHandleRecovery',
  kind: 'mutation',
  path: 'auth.requestHandleRecovery',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ email: z.string().trim().email().max(320) }),
  output: z.object({ accepted: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { email: 'a@example.com' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The owner's reset request cap: how many codes one address may ask for inside the window (J-identity-03 #2).
 * Null while the reset is unwired, so the page names no number it doesn't have. The same for every visitor.
 */
export const IDENTITY_AUTH_PASSWORD_RESET_LIMITS = defineProcedure({
  ...base,
  name: 'identity.auth.passwordResetLimits',
  kind: 'query',
  path: 'auth.passwordResetLimits',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ requestMax: z.number().int().positive(), windowSeconds: z.number().int().positive() }).nullable(),
  samples: [{ verdict: 'accept' }],
});

/**
 * Signed-out password reset, step 1 (D-38). Same answer whether or not
 * the email is registered. The one-time code is mailed, never returned.
 * The password hash does not change here.
 */
export const IDENTITY_AUTH_REQUEST_PASSWORD_RESET = defineProcedure({
  ...base,
  name: 'identity.auth.requestPasswordReset',
  kind: 'mutation',
  path: 'auth.requestPasswordReset',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ email: z.string().trim().email().max(320) }),
  output: z.object({ accepted: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { email: 'a@example.com' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Signed-out password reset, step 2. A correct proof replaces the hash
 * and ends the old sessions. This does not sign the caller in.
 */
export const IDENTITY_AUTH_COMPLETE_PASSWORD_RESET = defineProcedure({
  ...base,
  name: 'identity.auth.completePasswordReset',
  kind: 'mutation',
  path: 'auth.completePasswordReset',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({
    // Absent from the mailed link (J-identity-03 #2): the code alone names its flow.
    email: z.string().trim().email().max(320).optional(),
    code: z.string().trim().min(1).max(200),
    newPassword: z.string().max(200),
  }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { code: 'USDC', newPassword: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * What the sign-up page tells a person before they type a password (J-identity-01 #2): whether the owner's
 * breached-password list is set. `unset` means new passwords are not screened, and the page says so.
 * Public on purpose: the step's row (docs/roadmap/journeys.json) has the signed-out /register page say when the list
 * is not set, and product law has a page name a blank setting rather than hide it. It tells nothing about any
 * account, and a person typing a password is owed it; it says only on or unset, never the list or its size.
 */
export const IDENTITY_AUTH_SIGN_UP_PASSWORD_SCREENING = defineProcedure({
  ...base,
  name: 'identity.auth.signUpPasswordScreening',
  kind: 'query',
  path: 'auth.signUpPasswordScreening',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ breachedList: z.enum(['on', 'unset']) }),
  samples: [{ verdict: 'accept' }],
});

/**
 * Sign-up, step 1 (I-signin-sessions-18, I-kyc-compliance-06). Eligibility first (age, country,
 * nationality), then the password, then a six-digit code by email. Answers the same for a new address
 * and one that already has an account, and opens no session. Phone sign-up needs an SMS provider and
 * answers `vendor.sms` in this build; email sign-up works without it.
 */
export const IDENTITY_AUTH_SIGN_UP_START = defineProcedure({
  ...base,
  name: 'identity.auth.signUpStart',
  kind: 'mutation',
  path: 'auth.signUpStart',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({
    channel: z.enum(['email', 'phone']),
    handle: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/, 'handle must be 3-32 letters, numbers or underscores'),
    email: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().max(20).optional(),
    password: z.string().max(200),
    country: z.string().trim().length(2),
    /** ISO 3166-2 subdivision of residence (`CA-QC`); asked for where a subdivision is blocked on its own. */
    subdivision: z.string().trim().min(4).max(6).optional(),
    /** Country of citizenship (ISO 3166-1 alpha-2) or an ISO 3166-2 subdivision. */
    nationality: z.string().trim().min(2).max(6).optional(),
    /** A US citizen, green-card holder or US resident, wherever they live. Left out is refused by the service, never read as no. */
    usPerson: z.boolean().optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date of birth must be YYYY-MM-DD'),
    accountType: z.enum(ACCOUNT_TYPES),
    referrerId: z.string().guid().optional(),
    /**
     * The invitation link the person signed up from (CM-referral-01, ENGINE RF-1): its referrer is attached when
     * the account is made, outside the late-attach window. An unknown or revoked link names no one; it never
     * blocks the sign-up.
     */
    inviteToken: z.string().guid().optional(),
  }),
  output: signUpAccepted,
  samples: [
    {
      verdict: 'accept',
      input: {
        channel: 'email',
        handle: 'USDC',
        password: 'placeholder',
        country: 'en',
        dateOfBirth: '2026-01-01',
        accountType: 'individual',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Sign-up, step 1b: another code once the resend interval has passed. Same answer for either kind of address. */
export const IDENTITY_AUTH_SIGN_UP_RESEND = defineProcedure({
  ...base,
  name: 'identity.auth.signUpResend',
  kind: 'mutation',
  path: 'auth.signUpResend',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ flowId: z.string().guid() }),
  output: signUpAccepted,
  samples: [
    { verdict: 'accept', input: { flowId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Social sign-in, step 1. With no provider registered this answers the allowlisted `idp.social`.
 * The same answer for every provider name, so a name tells a caller nothing.
 */
export const IDENTITY_AUTH_OAUTH_START = defineProcedure({
  ...base,
  name: 'identity.auth.oauthStart',
  kind: 'mutation',
  path: 'auth.oauthStart',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ provider: socialProviderName }).strict(),
  output: z.object({ provider: z.string(), authorizationUrl: z.string(), expiresAt: z.string() }).strict(),
  samples: [
    { verdict: 'accept', input: { provider: 'x' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Act as one of your own sub-accounts (I-account-lifecycle-04): an access token on this session that names the
 * sub-account. Only a person signed in on the main account: an API key, or a token already acting as a
 * sub-account, is refused. No refresh token: a refresh returns to the main account. Rules: auth-service
 * `subAccountSession`.
 */
export const IDENTITY_AUTH_SUB_ACCOUNT_SESSION = defineProcedure({
  ...base,
  name: 'identity.auth.subAccountSession',
  kind: 'mutation',
  path: 'auth.subAccountSession',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ subAccountId: z.string().guid() }),
  output: z.object({
    accessToken: z.string(),
    expiresAt: z.string(),
    userId: z.string(),
    subAccountId: z.string(),
    label: z.string(),
    refreshable: z.literal(false),
  }),
  samples: [
    { verdict: 'accept', input: { subAccountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * WebAuthn options for step-up (passkey withdraw). Challenge kind is
 * `step-up` so a passwordless-login assertion cannot be reused here.
 */
export const IDENTITY_AUTH_STEP_UP_OPTIONS = defineProcedure({
  ...base,
  name: 'identity.auth.stepUpOptions',
  kind: 'mutation',
  path: 'auth.stepUpOptions',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: authenticationOptions,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_AUTH_LOGOUT_ALL = defineProcedure({
  ...base,
  name: 'identity.auth.logoutAll',
  kind: 'mutation',
  path: 'auth.logoutAll',
  access: { caller: 'person' },
  refusals: {},
  input: NO_INPUT,
  output: loggedOutEverywhereSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_AUTH_LOGIN = defineProcedure({
  ...base,
  name: 'identity.auth.login',
  kind: 'mutation',
  path: 'auth.login',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({
    identifier: z.string().min(1),
    password: z.string().min(1),
    totpCode: z.string().optional(),
    deviceKey: z.string().min(16).max(128).optional(),
    /** A solved `auth.challenge`, needed once this address reached the owner's count of failed sign-ins. */
    challenge: signInChallengeProofSchema.optional(),
  }),
  output: sessionOutput,
  samples: [
    { verdict: 'accept', input: { identifier: 'USDC', password: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_AUTH_REGISTER = defineProcedure({
  ...base,
  name: 'identity.auth.register',
  kind: 'mutation',
  path: 'auth.register',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({
    handle: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/, 'handle must be 3-32 letters, numbers or underscores'),
    email: z.string().email(),
    password: z.string().min(12).max(200),
    region: z.string().length(2).optional(),
    /** A native or API client's own device key, trusted with the new account (a browser's comes in `ifc_dk`). */
    deviceKey: z.string().min(16).max(128).optional(),
    /**
     * Optional referrer at signup. Same law as `affiliates.attribute`
     * (self/cycle/depth/unknown refuse loud). Blank = no edge.
     * Account is created first; a failed attribute still leaves the user
     * (they can fix referrer via attribute later if product allows once).
     */
    referrerId: z.string().guid().optional(),
  }),
  output: sessionOutput,
  samples: [
    { verdict: 'accept', input: { handle: 'USDC', email: 'a@example.com', password: 'placeholderx' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_AUTH_LOGOUT = defineProcedure({
  ...base,
  name: 'identity.auth.logout',
  kind: 'mutation',
  path: 'auth.logout',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ refreshToken: z.string().min(1).optional() }).optional(),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Is the founder enrolment door open? True only while the founder pair is not
 * pinned, invites are configured, the expiry has not passed and one is unspent.
 * Public and input-free; reveals nothing else.
 */
export const IDENTITY_AUTH_FOUNDER_ENROLMENT_STATUS = defineProcedure({
  ...base,
  name: 'identity.auth.founderEnrolmentStatus',
  kind: 'query',
  path: 'auth.founderEnrolmentStatus',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ open: z.boolean() }),
  samples: [{ verdict: 'accept' }],
});

/**
 * Confirm it's you, then mint a ten-minute access token that can refund
 * or pay out. The token is not refreshable. A plain session cannot call
 * payment.refund or settlement.payout.
 *
 * Input: `{ merchantId, scopes: ('pay:refund' | 'pay:payout')[], factorProof }`.
 * `factorProof` is exactly one of `{ totpCode }`, `{ webauthn }`,
 * or `{ proofId }` from a factor verified in the last five minutes
 * (`proveFreshFactor`, STEPUP #4880). A passkey assertion is signed over
 * the single-use challenge from `auth.stepUpOptions`.
 * Output: `{ accessToken, expiresAt, scopes, refreshable: false }`.
 * Refusals: `auth.step_up_required`, `auth.step_up_expired`, `pay.role_not_allowed`.
 * Nothing is minted on a refusal.
 */
export const IDENTITY_AUTH_STEP_UP_PAY = defineProcedure({
  ...base,
  name: 'identity.auth.stepUpPay',
  kind: 'mutation',
  path: 'auth.stepUpPay',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({
    merchantId: z.string().guid(),
    scopes: z
      .array(z.enum(['pay:refund', 'pay:payout']))
      .min(1)
      .max(2),
    factorProof: z.union([
      z.object({ totpCode: z.string().regex(/^\d{6}$/) }).strict(),
      z
        .object({
          webauthn: z.object({
            id: z.string().min(1),
            rawId: z.string().min(1),
            type: z.literal('public-key'),
            response: z.object({
              clientDataJSON: z.string().min(1),
              authenticatorData: z.string().min(1),
              signature: z.string().min(1),
              userHandle: z.string().nullish(),
            }),
            clientExtensionResults: z.record(z.string(), jsonValueSchema).optional(),
          }),
        })
        .strict(),
      z.object({ proofId: z.string().guid() }).strict(),
    ]),
  }),
  output: z.object({
    accessToken: z.string(),
    expiresAt: z.string(),
    scopes: z.array(z.string()),
    refreshable: z.literal(false),
  }),
  samples: [
    {
      verdict: 'accept',
      input: {
        merchantId: '11111111-1111-4111-8111-111111111111',
        scopes: ['pay:refund'],
        factorProof: {
          webauthn: {
            id: 'USDC',
            rawId: 'USDC',
            type: 'public-key',
            response: { clientDataJSON: 'USDC', authenticatorData: 'USDC', signature: 'USDC' },
          },
        },
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The second step by passkey (I-signin-sessions-10). `login` answered `auth.mfa_required` with a passkey challenge
 * (`secondStep.passkey`) once the password verified; the assertion over it opens a two-factor session. A passkey of
 * another account, or one bound to other actions, answers `auth.webauthn_invalid` and counts on the MFA lockout.
 */
export const IDENTITY_AUTH_LOGIN_SECOND_STEP_PASSKEY = defineProcedure({
  ...base,
  name: 'identity.auth.loginSecondStepPasskey',
  kind: 'mutation',
  path: 'auth.loginSecondStepPasskey',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({
    credential: z.object({
      id: z.string().min(1),
      rawId: z.string().min(1),
      type: z.literal('public-key'),
      response: z.object({
        clientDataJSON: z.string().min(1),
        authenticatorData: z.string().min(1),
        signature: z.string().min(1),
        userHandle: z.string().nullish(),
      }),
      clientExtensionResults: z.record(z.string(), jsonValueSchema).optional(),
    }),
    deviceKey: z.string().min(16).max(128).optional(),
  }),
  output: sessionOutput,
  samples: [
    {
      verdict: 'accept',
      input: {
        credential: {
          id: 'USDC',
          rawId: 'USDC',
          type: 'public-key',
          response: { clientDataJSON: 'USDC', authenticatorData: 'USDC', signature: 'USDC' },
        },
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Wallet sign-in, step 1 (I-account-lifecycle-07): the EIP-4361 message a wallet signs, single use. The same answer
 * for every wallet, linked or not.
 */
export const IDENTITY_AUTH_WALLET_CHALLENGE = defineProcedure({
  ...base,
  name: 'identity.auth.walletChallenge',
  kind: 'mutation',
  path: 'auth.walletChallenge',
  access: { caller: 'public' },
  refusals: {},
  input: walletChallengeInput,
  output: walletChallengeOutput,
  samples: [
    { verdict: 'accept', input: { address: 'USDC', chainId: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Wallet sign-in, step 2: the signature from a wallet an account linked signs that account in, and its second step
 * still follows. An unlinked wallet answers `auth.invalid_credentials`; the challenge is spent either way.
 */
export const IDENTITY_AUTH_WALLET_SIGN_IN = defineProcedure({
  ...base,
  name: 'identity.auth.walletSignIn',
  kind: 'mutation',
  path: 'auth.walletSignIn',
  access: { caller: 'public' },
  refusals: {},
  input: z
    .object({
      ...walletAnswerFields,
      totpCode: z.string().trim().min(1).max(64).optional(),
      deviceKey: z.string().min(16).max(128).optional(),
    })
    .strict(),
  output: sessionOutput,
  samples: [
    { verdict: 'accept', input: { flowId: '11111111-1111-4111-8111-111111111111', message: 'USDC', signature: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_AUTH_REFRESH = defineProcedure({
  ...base,
  name: 'identity.auth.refresh',
  kind: 'mutation',
  path: 'auth.refresh',
  access: { caller: 'public' },
  refusals: {},
  input: z
    .object({
      refreshToken: z.string().min(1).optional(),
      /** The app saw no use since its last refresh (an unused tab's timer): the idle sign-out keeps counting. */
      idle: z.boolean().optional(),
    })
    .optional(),
  output: sessionOutput,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
