import { z } from 'zod';
import { securityLockSchema } from './identity.js';
import { jsonValueSchema } from './procedure-strict-schema.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-identity's records share, moved from the service so the records and every caller read one copy. */

export const sessionOutput = z.object({
  accessToken: z.string(),
  /**
   * Present for a native or API client (no Origin). Omitted when the
   * request is a browser session: the refresh token is only in the
   * httpOnly `ifc_rt` cookie. Optional so both shapes parse.
   */
  refreshToken: z.string().optional(),
  expiresAt: z.string(),
  userId: z.string().guid(),
  /** A device key just trusted, for a native or API client only (a browser gets the `ifc_dk` cookie instead). */
  deviceKey: z.string().optional(),
  /** Present only when this sign-in's second step spent a recovery code: how many codes the account has left. */
  recoveryCodesLeft: z.number().int().min(0).optional(),
});

/** Blank / non-integer / out of 1..200 KYC pending queue limit. Never invent 50. */
export const SELF_FREEZE_REASONS = ['compromise', 'temporary', 'personal'] as const;

export const loginCodeAccepted = z.object({
  accepted: z.literal(true),
  flowId: z.string().guid(),
  resendAfterSeconds: z.number().int().positive(),
});

/**
 * Sign-up by email, with the code before the first session (I-signin-sessions-18) and the eligibility check
 * at the door (I-kyc-compliance-06).
 *
 * `start` checks, in this order: age (owner `IDENTITY_SIGNUP_MIN_AGE_YEARS`), then the country of residence and
 * the optional nationality (a real ISO country, not switched off by the owner, not on the screening list), then
 * the password. Nothing is written on a refusal. A good record writes one `auth_flows` row, one `signup_drafts`
 * row and one `mail_outbox` row, and answers `{ accepted, next: 'confirm_email', flowId }` with no session.
 *
 * A new address and an address that already has an account get the same answer and the same work: the
 * password is hashed, the three rows are written. The new address is mailed a six-digit code; the known one is
 * mailed a "someone tried to sign up with your address" notice, and its flow is `suppressed`, so no code
 * finishes it. `confirm` makes the account only when the right code is entered, inside one transaction with
 * the flow consumed and the draft (and its password hash) deleted.
 *
 * Blank owner numbers refuse every caller the same way (`identity.signup_unwired`, `identity.age_rule_unset`);
 * nothing here invents a lifetime, a cap or an age. The date of birth is used for the age check and, with the KYC
 * document key set (`birthDateKey`), kept sealed for the trading checks' sanctions screen (`birth_dates`, J-cex-spot-01
 * #3); never in plaintext, and with the key unset it is not kept at all.
 */
export const ACCOUNT_TYPES = ['individual', 'business'] as const;

export const signUpAccepted = z.object({
  accepted: z.literal(true),
  next: z.literal('confirm_email'),
  flowId: z.string().guid(),
  resendAfterSeconds: z.number().int().positive(),
});

export const socialProviderName = z.string().regex(/^[a-z0-9-]{1,32}$/);

/** The most account ids one handle lookup takes: a desk asks for the owners on the page it shows, never the whole base. */
export const HANDLES_CAP = 200;

export const waveOutput = z.object({
  waveNumber: z.number().int().positive(),
  size: z.number().int().positive(),
  releasedCount: z.number().int().positive(),
  flagKey: z.string(),
  releasedBy: z.string().guid(),
  approvedBy: z.string().guid(),
  releasedAt: z.string(),
});

export const waitlistPlaceOutput = z.object({
  position: z.number().int().positive(),
  referralCode: z.string(),
  referredCount: z.number().int().min(0),
  queueLength: z.number().int().min(0),
  /** Place among those still waiting (more referrals first, ties by join order); null once released. */
  rank: z.number().int().positive().nullable(),
  waiting: z.number().int().min(0),
  release: z.object({ waveNumber: z.number().int().positive(), releasedAt: z.string() }).nullable(),
});

export const kycRecordOutput = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  tier: z.enum(['none', 'basic', 'full', 'institutional']),
  jurisdiction: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  reviewedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

/** The tiers a user can ask for. `none` is the absence of a record, not a request. */
export const submittableTier = z.enum(['basic', 'full', 'institutional']);

export const profileOutput = z.object({
  displayName: z.string().nullable(),
  locale: z.string(),
  region: z.string().nullable(),
  version: z.number().int(),
});

export const settingsOutput = z.object({
  handle: z.string(),
  discoverable: z.boolean(),
  changesUsed: z.number().int().min(0),
  changeCap: z.number().int().min(1).nullable(),
  changesLeft: z.number().int().min(0).nullable(),
});

export const listOutput = z.object({
  contacts: z.array(z.object({ id: z.string().guid(), channel: z.enum(['email', 'phone']), target: z.string(), verified: z.boolean() })),
  max: z.number().int().min(1).nullable(),
});

export const SUB_ACCOUNT_KINDS = ['standard', 'managed', 'derivatives', 'spot'] as const;

export const blocker = z.object({ code: z.string(), count: z.number().int() });

export const balance = z.object({ assetId: z.string(), amount: z.string() });

/**
 * The trading products svc-trade serves today: spot, convert, futures, algo (TWAP) and copy. Margin is not listed: the
 * margin terms are stored but no borrow door exists. Bots trade through API keys, not a separate product.
 */
export const SUB_ACCOUNT_FEATURES = ['spot', 'convert', 'futures', 'algo', 'copy'] as const;

export const feature = z.enum(SUB_ACCOUNT_FEATURES);

export const status = z.object({
  enabled: z.boolean(),
  label: z.string().nullable(),
  enrolledAt: z.string().nullable(),
  recoveryCodesLeft: z.number().int(),
});

export const requestId = z.string().min(1).max(128);

export const approvalId = z.string().min(1).max(128).nullish();

export const code = z.string().trim().min(6).max(64);

export const PARTNER_REJECT_CATEGORIES = ['not_enough_activity', 'incomplete_application', 'compliance', 'other'] as const;

/**
 * What the person sees of their own partner application (CM-referral-05). An approval shows its reason; a rejection
 * shows its category and the reapply date, never the operator's notes or name.
 */
export const partnerForCustomer = z.object({
  applicationId: z.string().uuid(),
  state: z.enum(['submitted', 'approved', 'rejected']),
  qualifiedCount: z.number().int().nonnegative(),
  requiredCount: z.number().int().positive(),
  approvalReason: z.string().nullable(),
  rejectCategory: z.enum(PARTNER_REJECT_CATEGORIES).nullable(),
  reapplyAt: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});

/** An ended referral relationship (CM-referral-01 RF-4): who it was with, from when, the last activity and the end. */
export const lapseOutput = z.object({
  userId: z.string().uuid(),
  referrerId: z.string().uuid(),
  attributedAt: z.string(),
  lastActivityAt: z.string(),
  periodSeconds: z.number().int(),
  lapsedAt: z.string(),
});

/** Where a link can be shared from. A closed list, so a count always names a real place. */
export const SHARE_SURFACES = ['promotion', 'card', 'token', 'strategy', 'receipt'] as const;

export const rebindStateSchema = z.enum(['submitted', 'under_review', 'approved', 'rejected', 'withdrawn', 'expired']);

/** What the person sees of their own referrer change request. The deciding operator is not named. */
export const rebindForCustomer = z.object({
  requestId: z.string().uuid(),
  state: rebindStateSchema,
  fromReferrerId: z.string().uuid().nullable(),
  toReferrerId: z.string().uuid(),
  reason: z.string(),
  decisionReason: z.string().nullable(),
  createdAt: z.string(),
  reviewEndsAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  appliedAt: z.string().nullable(),
});

/** A browser session's own random key: one visit per session per surface. */
export const SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const changeSchema = securityLockSchema.extend({ changed: z.boolean() }).strict();

export const settingsOut = z
  .object({
    owner: z.object({ idleSeconds: z.number().int().nullable(), maxDevices: z.number().int().nullable() }).strict(),
    own: z.object({ idleSeconds: z.number().int().nullable() }).strict(),
    range: z.object({ minSeconds: z.number().int(), maxSeconds: z.number().int() }).strict(),
    appliedIdleSeconds: z.number().int().nullable(),
    absoluteSeconds: z.number().int(),
  })
  .strict();

export const methodsOutput = z.object({
  password: z.boolean(),
  emailCode: z.object({ on: z.boolean(), address: z.string().nullable(), proved: z.boolean() }),
  passkeys: z.number().int(),
  wallets: z.array(z.object({ address: z.string(), linkedAt: z.string() })),
  providers: z.array(z.string()),
  phone: z.string().nullable(),
});

export const clientRequestId = z.string().min(1).max(128);

export const stepUpApprovalId = z.string().min(1).max(128).nullish();

export const phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);

/** A wallet's signed answer, for linking it here and for signing in with it (`auth.walletSignIn`): one shape for both. */
export const walletAnswerFields = {
  flowId: z.string().guid(),
  message: z.string().min(1).max(2000),
  signature: z.string().min(1).max(4000),
};

export const walletAnswer = z.object(walletAnswerFields).strict();

/** The wallet asking for a message to sign, to link it or to sign in with it. */
export const walletChallengeInput = z
  .object({
    address: z.string().min(1).max(64),
    chainId: z
      .number()
      .int()
      .positive()
      .max(2 ** 53 - 1),
    origin: z.string().max(256).optional(),
  })
  .strict();

export const walletChallengeOutput = z.object({ flowId: z.string(), message: z.string(), expiresAt: z.string() });

export const iso = z.string().datetime({ offset: true });

export const factorProofSchema = z.union([
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
]);

/** Optional on the wire so a missing proof is the typed refusal, not a parse error. */
export const optionalFactorProof = factorProofSchema.optional();
