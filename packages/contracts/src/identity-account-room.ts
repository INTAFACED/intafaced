/**
 * What svc-identity answers the customer's account room (module `identity`): the authenticator and its step-up, signed-in
 * devices and trusted devices, passkeys and signing out everywhere, the membership offer, the partner programme and the
 * referral records. Browser-safe (zod only), so the app reads each answer with the one schema here and narrows it where a
 * caller needs more (a check against the caller's own request or user stays in the app).
 */
import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { unsignedAmountSchema } from './wire-amount.js';

const guid = z.string().guid();
const isoDate = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------------------------------------------------
// The authenticator (`totpManage`) and the step-up that gates turning it off or replacing it.

export const totpStatusSchema = z.object({
  enabled: z.boolean(),
  label: z.string().nullable(),
  enrolledAt: z.string().nullable(),
  recoveryCodesLeft: z.number().int().min(0),
});
export const stepUpBegunSchema = z.object({ challengeId: z.string().guid() }).passthrough();
export const stepUpDoneSchema = z.object({ stepUpApprovalId: z.string().min(1) }).passthrough();
/** `auth.stepUp`: the short token a fresh factor buys, and the scopes it carries. */
export const stepUpTokenSchema = z.object({ accessToken: z.string().min(1), expiresAt: z.string().min(1), scopes: z.array(z.string()) });
export const totpDisabledSchema = z.object({ disabled: z.literal(true), recoveryCodeSpent: z.boolean() });
export const totpReplaceStartedSchema = z.object({ secret: z.string().regex(/^[A-Z2-7]{16,}$/), uri: z.string() });
export const totpReplacedSchema = z.object({
  replaced: z.literal(true),
  recoveryCodeSpent: z.boolean(),
  /** The new recovery codes, shown once; the old ones stopped working with the swap. */
  recoveryCodes: z.array(z.string()).min(1),
  /** Other sessions of the account that the swap ended (the lost phone among them). */
  sessionsEnded: z.number().int().min(0),
});
/** `totp.setup`: the new secret, its otpauth URI (issuer INTAFACED, SHA1, six digits, 30 s) and ten distinct recovery codes. */
export const totpSetupSchema = z
  .object({
    secret: z.string().regex(/^[A-Z2-7]{16,}$/),
    uri: z.string(),
    recoveryCodes: z.array(z.string().regex(/^[A-F0-9]{5}-[A-F0-9]{5}$/)).length(10),
  })
  .refine((value) => {
    try {
      const uri = new URL(value.uri);
      return (
        uri.protocol === 'otpauth:' &&
        uri.hostname === 'totp' &&
        uri.searchParams.get('secret') === value.secret &&
        uri.searchParams.get('issuer') === 'INTAFACED' &&
        uri.searchParams.get('algorithm') === 'SHA1' &&
        uri.searchParams.get('digits') === '6' &&
        uri.searchParams.get('period') === '30' &&
        new Set(value.recoveryCodes).size === value.recoveryCodes.length
      );
    } catch {
      return false;
    }
  });
/** `totp.confirm`. */
export const totpConfirmedSchema = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------------------------------------------------
// Passkeys (`webauthn`) and signing out everywhere.

/** An instant with an offset whose calendar date exists (no 31 February). */
export const securityInstantSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const date = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(value);
    if (!date || !Number.isFinite(Date.parse(value))) return false;
    const calendar = new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])));
    return (
      calendar.getUTCFullYear() === Number(date[1]) &&
      calendar.getUTCMonth() === Number(date[2]) - 1 &&
      calendar.getUTCDate() === Number(date[3])
    );
  });
/** A credential id's base64url bytes. */
export function credentialBytes(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
}
/** The unpadded base64url text of a credential id's bytes. */
export function credentialReference(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
/** A passkey's credential id: canonical unpadded base64url, at most 8192 characters. */
export const credentialIdSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
    try {
      return credentialReference(credentialBytes(value)) === value;
    } catch {
      return false;
    }
  });
export const passkeySchema = z.object({
  credentialId: credentialIdSchema,
  createdAt: securityInstantSchema,
  transports: z.array(z.string()).optional(),
});
/** `webauthn.registerVerify`. */
export const passkeyRegisteredSchema = z.object({ credentialId: credentialIdSchema });
/** `webauthn.remove`. */
export const passkeyRemovedSchema = z.object({ removed: z.boolean() });
/** `auth.logoutAll`: how many sessions it ended. */
export const loggedOutEverywhereSchema = z.object({ revoked: z.number().int().safe().nonnegative() });

// ---------------------------------------------------------------------------------------------------------------------
// Signed-in devices (`listSessions` and the family sign-outs) and trusted devices (`trustedDevices`).

export const deviceListSchema = z.object({
  userId: z.string().guid(),
  sessions: z.array(
    z.object({
      id: z.string().guid(),
      familyId: z.string().guid(),
      createdAt: z.string(),
      lastUsedAt: z.string(),
      device: z.string().nullable(),
      userAgent: z.string().nullable(),
      country: z.string().nullable(),
      isCurrent: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const familyEndedSchema = z.object({ familyId: z.string().guid(), revoked: z.boolean() });
export const othersEndedSchema = z.object({ revokedFamilies: z.number().int().min(0) });

/** `trustedDevices.list`: whether the check is on, the account's trusted devices, and the sign-ins waiting for approval. */
export const trustedDevicesSchema = z.object({
  check: z.enum(['on', 'off']),
  devices: z.array(
    z.object({
      id: z.string().guid(),
      label: z.string(),
      firstSeenAt: isoDate,
      lastSeenAt: isoDate,
      trustedUntil: isoDate.nullable(),
      current: z.boolean(),
      /** A new-device sign-in on it the person has not confirmed yet: Home's "Needs you" asks about it. */
      newSignIn: z.boolean(),
    }),
  ),
  waiting: z.array(z.object({ flowId: z.string().guid(), label: z.string(), createdAt: isoDate, expiresAt: isoDate })),
});
export const trustedDeviceRemovedSchema = z.object({ removed: z.boolean(), sessionsEnded: z.number().int().nonnegative() });
export const trustedDeviceApprovedSchema = z.object({ approved: z.literal(true) });
export const signInConfirmedSchema = z.object({ confirmed: z.number().int().nonnegative() });

// ---------------------------------------------------------------------------------------------------------------------
// The membership offer (`membership.offer`): no tier while none is published.

const membershipTierSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    price: z.string(),
    assetId: assetIdSchema,
    periodDays: z.number().int(),
    perks: z.array(z.string()),
  })
  .strict();
export const membershipOfferSchema = z.union([
  z.object({ offered: z.literal(false), code: z.literal('identity.membership_not_offered') }).strict(),
  z.object({ offered: z.literal(true), tiers: z.array(membershipTierSchema), current: z.null() }).strict(),
]);

// ---------------------------------------------------------------------------------------------------------------------
// The partner programme (`affiliates.partnerEligibility`, `myPartnerApplication`, `applyPartner`, `mySubTree`).

export const partnerEligibilitySchema = z.object({
  requiredCount: z.number().int().positive(),
  qualifiedCount: z.number().int().nonnegative(),
  eligible: z.boolean(),
});
export const PARTNER_REJECT_CATEGORIES = ['not_enough_activity', 'incomplete_application', 'compliance', 'other'] as const;
export const partnerApplicationSchema = z.object({
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
export const partnerSubTreeSchema = z.object({
  depth: z.number().int().positive(),
  members: z.array(z.object({ handle: z.string(), level: z.number().int().positive(), joinedAt: z.string() })),
  beyondDepth: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------------------------------------------------
// Referral records (`affiliates.myReferrer`, `affiliates.myAccruals`, `affiliates.myLapse`).

const nonblank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'Expected a published identifier');
/** svc-identity stores exact unsigned decimals with at most 18 fractional places. */
export const referralAmountSchema = unsignedAmountSchema.and(z.string().regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/));
export const referralAccrualSchema = z.object({
  feeEventId: nonblank,
  beneficiaryId: guid,
  payerId: guid,
  hop: z.number().int().nonnegative(),
  /** At most one: with the canonical form above, a whole part of 0, or 1 with only zeros after the point. */
  rate: referralAmountSchema.refine((value) => /^(0(\.\d+)?|1(\.0+)?)$/.test(value), 'Rate exceeds one'),
  feeAmount: referralAmountSchema,
  commissionAmount: referralAmountSchema,
  asset: nonblank,
  accruedAt: isoDate,
  sourceModule: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
});
export const referralLapseSchema = z.object({
  state: z.enum(['unset', 'none', 'active']),
  periodSeconds: z.number().int().positive().nullable(),
  lastActivityAt: isoDate.nullable(),
  endsAt: isoDate.nullable(),
  ended: z
    .object({
      userId: z.string().uuid(),
      referrerId: z.string().uuid(),
      attributedAt: isoDate,
      lastActivityAt: isoDate,
      periodSeconds: z.number().int().positive(),
      lapsedAt: isoDate,
    })
    .nullable(),
});
/** `affiliates.myReferrer`: who referred the caller, or null. */
export const referralEdgeSchema = z.object({ userId: guid, referrerId: guid, attributedAt: isoDate }).nullable();
/** `affiliates.myAccruals` for a page of `limit` rows. */
export const referralAccrualsSchema = (limit: number) => z.object({ rows: z.array(referralAccrualSchema).max(limit) });
