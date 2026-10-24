/**
 * Recovery keys (RC-identity-07, J-identity-05 #7): keys the account owner gives to people they trust, so that after a
 * confirmed death notice those people, and never staff, can move the trading balances to the one account the owner
 * named. Identity keeps only a SHA-256 fingerprint of each key's public half; the private half stays with the person
 * who holds it.
 *
 * A key of kind `key` is an ECDSA P-256 key pair. Its public half travels as a JWK, and its fingerprint is the hex
 * SHA-256 of `p256.<x>.<y>` (the JWK's base64url coordinates). The fingerprint is computed with Web Crypto, so the
 * browser and the service get the same bytes. Kinds `passkey` and `guardian` are named in the table for later and are
 * refused today (`identity.recovery_kind_not_wired`).
 */
import { z } from 'zod';

export const RECOVERY_KEY_KINDS = ['key', 'passkey', 'guardian'] as const;
export type RecoveryKeyKind = (typeof RECOVERY_KEY_KINDS)[number];

/** The step-up that every change to the owner's recovery keys, heir or threshold spends. */
export const RECOVERY_KEY_STEP_UP_SCOPE = 'identity.step_up.recovery_key_change' as const;
export const RECOVERY_KEY_STEP_UP_PURPOSE = 'account.recoveryKey.change' as const;
/** What the step-up binds as its target: the key's fingerprint to add, the key id to revoke, or the heir and threshold. */
export const RECOVERY_KEY_CHANGES = ['add', 'revoke', 'plan'] as const;
export type RecoveryKeyChange = (typeof RECOVERY_KEY_CHANGES)[number];

const base64url = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/**
 * The public half of a P-256 recovery key: these four members only. Strict, so a private `d` sent by mistake is refused,
 * never silently dropped; a caller picks the four from what Web Crypto exports (which adds `ext` and `key_ops`).
 */
export const recoveryPublicJwkSchema = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: base64url, y: base64url }).strict();
export type RecoveryPublicJwk = z.infer<typeof recoveryPublicJwkSchema>;

export const RECOVERY_FINGERPRINT_RE = /^[0-9a-f]{64}$/;
export const RECOVERY_LABEL_MAX = 64;
export const RECOVERY_HANDLE_RE = /^[a-zA-Z0-9_]{3,32}$/;

/** The bytes a fingerprint is taken over: one line, so a key can never be read two ways. */
export function recoveryKeyMaterial(jwk: RecoveryPublicJwk): string {
  return `p256.${jwk.x}.${jwk.y}`;
}

/** Hex SHA-256 of the key's public material, the only thing identity stores about a key. */
export async function recoveryKeyFingerprint(jwk: RecoveryPublicJwk): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(recoveryKeyMaterial(jwk)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The step-up target of a heir and threshold change: the heir's handle as typed, lower case, and the threshold. */
export function recoveryPlanTarget(heirHandle: string, threshold: number): string {
  return `plan:${heirHandle.replace(/^@/, '').toLowerCase()}:${threshold}`;
}

export const recoveryKeyRowSchema = z
  .object({
    id: z.string().guid(),
    kind: z.enum(RECOVERY_KEY_KINDS),
    label: z.string(),
    fingerprint: z.string().regex(RECOVERY_FINGERPRINT_RE),
    createdAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type RecoveryKeyRow = z.infer<typeof recoveryKeyRowSchema>;

/**
 * The owner's recovery setup. `ready` is true when a heir with an active account is named, a threshold is set and at
 * least that many keys are live; otherwise `missing` names what is not there, and a claim would be refused.
 */
export const recoveryViewSchema = z
  .object({
    heir: z.object({ handle: z.string(), active: z.boolean() }).strict().nullable(),
    threshold: z.number().int().min(1).nullable(),
    keys: z.array(recoveryKeyRowSchema),
    activeKeys: z.number().int().min(0),
    ready: z.boolean(),
    missing: z.array(z.enum(['heir', 'threshold', 'keys'])),
  })
  .strict();
export type RecoveryView = z.infer<typeof recoveryViewSchema>;

export const RECOVERY_REFUSAL_CODES = [
  'identity.recovery_staff_forbidden',
  'identity.recovery_key_invalid',
  'identity.recovery_key_revoked',
  'identity.recovery_key_not_found',
  'identity.recovery_kind_not_wired',
  'identity.recovery_heir_unknown',
  'identity.recovery_heir_self',
  'identity.recovery_threshold_too_high',
] as const;
export type RecoveryRefusalCode = (typeof RECOVERY_REFUSAL_CODES)[number];

// ── Death notices (RC-identity-02) ──────────────────────────────────────────────────────────────────────────────────

export const DEATH_NOTICE_STATES = ['received', 'confirmed', 'rejected'] as const;
export const DEATH_NOTICE_REPORTERS = ['executor', 'administrator', 'family', 'other'] as const;
/** The four-eyes approval a second person gives before a notice is confirmed. Filed at svc-identity against the account. */
export const DEATH_NOTICE_CONFIRM_ACTION_TYPE = 'identity.death_notice_confirm' as const;
export const DEATH_NOTICE_TARGET_SERVICE = 'svc-identity' as const;
export const DEATH_NOTICE_VERSION = '1' as const;

/** What staff see of one notice. `approvalProposal` is what the second person approves for `confirm`. */
export const deathNoticeViewSchema = z
  .object({
    noticeId: z.string().guid(),
    userId: z.string().guid(),
    caseRef: z.string(),
    status: z.enum(DEATH_NOTICE_STATES),
    reporterKind: z.enum(DEATH_NOTICE_REPORTERS),
    evidenceDocumentIds: z.array(z.string().guid()),
    recordedBy: z.string().guid(),
    receivedAt: z.string().datetime({ offset: true }),
    decidedAt: z.string().datetime({ offset: true }).nullable(),
    decidedBy: z.string().guid().nullable(),
    approvedBy: z.string().guid().nullable(),
    approvalProposal: z
      .object({
        actionType: z.literal(DEATH_NOTICE_CONFIRM_ACTION_TYPE),
        targetService: z.literal(DEATH_NOTICE_TARGET_SERVICE),
        targetId: z.string().guid(),
        expectedVersion: z.literal(DEATH_NOTICE_VERSION),
        payloadHash: z.string(),
      })
      .strict(),
  })
  .strict();
export type DeathNoticeView = z.infer<typeof deathNoticeViewSchema>;

// ── Recovery claims (RC-identity-08): what svc-bank asks identity before it sweeps ──────────────────────────────────

/**
 * The text every recovery key signs for one claim: ECDSA P-256 with SHA-256, the signature as Web Crypto writes it
 * (r and s, 64 bytes, base64url). It names the account, the heir and the claim, so a signature answers for that claim only.
 */
export function recoveryClaimMessage(claim: { userId: string; heirUserId: string; claimId: string }): string {
  return [
    'INTAFACED recovery claim v1',
    `account:${claim.userId.toLowerCase()}`,
    `heir:${claim.heirUserId.toLowerCase()}`,
    `claim:${claim.claimId.toLowerCase()}`,
  ].join('\n');
}

/** `POST`, service credentials, svc-bank only. */
export const RECOVERY_CLAIM_VERIFY_PATH = '/internal/recovery-claims/verify' as const;
export const RECOVERY_CLAIM_SIGNATURES_MAX = 32;

export const recoveryClaimSignatureSchema = z
  .object({ publicKey: recoveryPublicJwkSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) })
  .strict();
export const recoveryClaimVerifyRequestSchema = z
  .object({
    userId: z.string().guid(),
    heirUserId: z.string().guid(),
    claimId: z.string().guid(),
    signatures: z.array(recoveryClaimSignatureSchema).min(1).max(RECOVERY_CLAIM_SIGNATURES_MAX),
  })
  .strict();
export type RecoveryClaimVerifyRequest = z.infer<typeof recoveryClaimVerifyRequestSchema>;

export const RECOVERY_CLAIM_REFUSALS = [
  'identity.recovery_notice_unconfirmed',
  'identity.recovery_account_changed',
  'identity.recovery_changed_after_notice',
  'identity.recovery_heir_mismatch',
  'identity.recovery_heir_inactive',
  'identity.recovery_threshold_unset',
  'identity.recovery_key_unknown',
  'identity.recovery_key_revoked',
  'identity.recovery_signature_invalid',
  'identity.recovery_signatures_short',
] as const;
export type RecoveryClaimRefusal = (typeof RECOVERY_CLAIM_REFUSALS)[number];

/**
 * Identity's answer, read under the account's lock at the moment of asking: the confirmed notice, the heir the owner
 * named, and distinct live keys that signed this claim, at least the owner's threshold. A refusal names the first
 * thing that failed; svc-bank refuses the claim with it and moves nothing.
 */
export const recoveryClaimVerdictSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      noticeId: z.string().guid(),
      threshold: z.number().int().min(1),
      signerKeyIds: z.array(z.string().guid()),
    })
    .strict(),
  z.object({ ok: z.literal(false), code: z.enum(RECOVERY_CLAIM_REFUSALS) }).strict(),
]);
export type RecoveryClaimVerdict = z.infer<typeof recoveryClaimVerdictSchema>;
