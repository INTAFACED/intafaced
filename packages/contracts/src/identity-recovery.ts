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
/** The public half of a P-256 recovery key, as Web Crypto exports it (extra JWK members such as `ext` are dropped). */
export const recoveryPublicJwkSchema = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: base64url, y: base64url });
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
