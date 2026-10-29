/**
 * Personal API keys made in the developer room (`/uc/safe/api-keys`, DV-keys-01 and the list half of DV-keys-03,
 * journey J-developer-03). One create door that applies the whole policy in one call: a fresh second factor, a
 * non-empty scope list a key may hold, a name unique on the account without regard to case, an optional literal IP
 * list and end date, and the owner's key cap for the account's verification level. The secret is in the reply once;
 * a repeat of the same request id returns the same record with `key: null`, never the secret again.
 *
 * Browser-safe: zod only. The service adds its own second-factor field to the create input.
 */
import { z } from 'zod';

export const API_KEY_NAME_MAX = 64;
/** Most entries one create may carry in its scope or IP list; the service refuses longer lists by shape. */
export const API_KEY_LIST_MAX = 64;

/** Typed refusals of the create door, as the service names them (`data.cause.code`). */
export const API_KEY_CREATE_REFUSALS = [
  'auth.step_up_required',
  'auth.step_up_expired',
  'auth.scope_empty',
  'auth.scope_unknown',
  'auth.scope_interactive_only',
  'auth.scope_not_held',
  'auth.ip_invalid',
  'identity.key_name_invalid',
  'identity.key_name_taken',
  'identity.key_expiry_invalid',
  'identity.key_cap_unset',
  'identity.key_cap_reached',
  'identity.key_request_conflict',
] as const;
export type ApiKeyCreateRefusal = (typeof API_KEY_CREATE_REFUSALS)[number];

const isoInstant = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}, 'ISO instant');

/** A business key the client derives from what it asked for and what it last read (`apiKeyCreateRequestId`). */
export const apiKeyRequestIdSchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9:._-]+$/);

export const apiKeyCreateInputSchema = z
  .object({
    requestId: apiKeyRequestIdSchema,
    name: z.string().max(API_KEY_NAME_MAX * 4),
    /** May be empty on the wire, so an empty list is the typed `auth.scope_empty`, not a parse error. */
    scopes: z.array(z.string().max(64)).max(API_KEY_LIST_MAX),
    /** Literal IPv4 or IPv6 addresses. Empty or absent leaves the key open to any address. */
    ips: z.array(z.string().max(64)).max(API_KEY_LIST_MAX).optional(),
    /** The key stops working at this instant. Absent: no end date. */
    expiresAt: isoInstant.optional(),
  })
  .strict();
export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateInputSchema>;

/**
 * Why a key stopped working before its end date, as the service recorded it at the revoke: the person revoked it
 * (`owner`), the account was frozen (`account_freeze`, by the person or by staff), an operator revoked this one key
 * (`operator`), or the account was closed (`account_closed`). Null on a key revoked before causes were recorded.
 */
export const API_KEY_REVOKED_BY = ['owner', 'account_freeze', 'operator', 'account_closed'] as const;
export type ApiKeyRevokedBy = (typeof API_KEY_REVOKED_BY)[number];
/** Longest reason the person may give when they revoke their own key. */
export const API_KEY_REVOKE_REASON_MAX = 200;

export const apiKeyRecordSchema = z
  .object({
    id: z.string().guid(),
    name: z.string(),
    prefix: z.string(),
    mode: z.enum(['live', 'sandbox']),
    scopes: z.array(z.string()),
    ipAllowlist: z.array(z.string()),
    requireSignature: z.boolean(),
    createdAt: isoInstant,
    expiresAt: isoInstant.nullable(),
    lastUsedAt: isoInstant.nullable(),
    revoked: z.boolean(),
    /** When the key was revoked. Null while live, and on a key revoked before this was recorded. */
    revokedAt: isoInstant.nullable(),
    revokedBy: z.enum(API_KEY_REVOKED_BY).nullable(),
    /** The reason the person typed when they revoked it themselves. An operator's own note is never shown here. */
    revokeReason: z.string().max(API_KEY_REVOKE_REASON_MAX).nullable(),
  })
  .strict();
export type ApiKeyRecord = z.infer<typeof apiKeyRecordSchema>;

export const apiKeyCreateOutputSchema = z
  .object({
    record: apiKeyRecordSchema,
    /** The key, in this reply only. Null when this reply answers a repeat of the same request id. */
    key: z.string().nullable(),
    replayed: z.boolean(),
  })
  .strict();
export type ApiKeyCreateOutput = z.infer<typeof apiKeyCreateOutputSchema>;

/**
 * The owner's key cap for this account's verification level. `limit: null` means the owner has not set it, and
 * every create refuses `identity.key_cap_unset`. `live` counts keys that are neither revoked nor past their end date.
 */
export const apiKeyCapSchema = z.object({ limit: z.number().int().min(0).nullable(), live: z.number().int().min(0) }).strict();
export type ApiKeyCap = z.infer<typeof apiKeyCapSchema>;

export const apiKeyListInputSchema = z.object({ limit: z.number().int().min(1).max(200) }).strict();
export const apiKeyListOutputSchema = z
  .object({ keys: z.array(apiKeyRecordSchema).max(200), cap: apiKeyCapSchema })
  .strict()
  .refine((list) => new Set(list.keys.map((key) => key.id)).size === list.keys.length, 'each key once');
export type ApiKeyList = z.infer<typeof apiKeyListOutputSchema>;

/** One key of the signed-in person, by id (`developerKeys.get`). */
export const apiKeyGetInputSchema = z.object({ keyId: z.string().guid() }).strict();

/**
 * The key detail page (`/uc/safe/api-keys/:keyId`): the record, its IP policy and the owner's idle expiry.
 * `idleExpirySeconds: null` means the owner has not set an idle period (`not set`); nothing is ever defaulted.
 */
export const apiKeyDetailSchema = z
  .object({
    key: apiKeyRecordSchema,
    /** When true, an empty IP list refuses every call instead of leaving the key open to any address. */
    requireNonEmptyIpAllowlist: z.boolean(),
    idleExpirySeconds: z.number().int().positive().nullable(),
  })
  .strict();
export type ApiKeyDetail = z.infer<typeof apiKeyDetailSchema>;

/** Typed refusals of the revoke and end-date doors, besides the second-factor ones. */
export const API_KEY_CHANGE_REFUSALS = [
  'auth.step_up_required',
  'auth.step_up_expired',
  'identity.key_not_found',
  'identity.key_not_live',
  'identity.key_expiry_invalid',
  'identity.key_revoke_reason_invalid',
] as const;
export type ApiKeyChangeRefusal = (typeof API_KEY_CHANGE_REFUSALS)[number];

/**
 * The person's own revoke (`developerKeys.revoke`). It never needs a second factor, so a key can always be switched
 * off. A repeat on a revoked key changes nothing and returns the record as it is (the first reason stays).
 */
export const apiKeyRevokeInputSchema = z
  .object({
    keyId: z.string().guid(),
    reason: z
      .string()
      .max(API_KEY_REVOKE_REASON_MAX * 4)
      .optional(),
  })
  .strict();
export type ApiKeyRevokeInput = z.infer<typeof apiKeyRevokeInputSchema>;
export const apiKeyRevokeOutputSchema = z.object({ record: apiKeyRecordSchema, changed: z.boolean() }).strict();
export type ApiKeyRevokeOutput = z.infer<typeof apiKeyRevokeOutputSchema>;

/**
 * A new end date for a live key (`developerKeys.setExpiry`). An earlier end (or a first one) only narrows the key and
 * needs no second factor; a later one widens it and needs a fresh one, as create does. A key can never call this.
 */
export const apiKeySetExpiryInputSchema = z.object({ keyId: z.string().guid(), expiresAt: isoInstant }).strict();
export type ApiKeySetExpiryInput = z.infer<typeof apiKeySetExpiryInputSchema>;
export const apiKeySetExpiryOutputSchema = z.object({ record: apiKeyRecordSchema }).strict();

/**
 * Why a scope cannot sit on a key: it moves value off the platform or is interactive-only (`interactive_only`), it is
 * granted only under a pay step-up (`step_up_only`), or it belongs to an operator's desk (`operator_only`).
 */
export const API_KEY_SCOPE_BLOCKS = ['interactive_only', 'step_up_only', 'operator_only'] as const;
export const apiKeyScopeEntrySchema = z
  .object({
    scope: z.string(),
    /** `read` scopes never change anything; `write` scopes act. */
    access: z.enum(['read', 'write']),
    onKey: z.boolean(),
    blockedBy: z.enum(API_KEY_SCOPE_BLOCKS).nullable(),
  })
  .strict();
export type ApiKeyScopeEntry = z.infer<typeof apiKeyScopeEntrySchema>;
export const apiKeyScopesOutputSchema = z.object({ scopes: z.array(apiKeyScopeEntrySchema).max(200) }).strict();

/** FNV-1a, 64 bits: a short stable digest, so a request id stays well under 200 characters. */
function digest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const unit of new TextEncoder().encode(text)) {
    hash ^= BigInt(unit);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * The request id of one create: a business key, never random. It names the person, the key list they last read
 * (each key's id and whether it is revoked) and the key they asked for. A retry after a lost reply sends the same id
 * and gets the record back without the secret; once the list has changed (the key appeared, or one was revoked), the
 * same form makes a new id, so a revoked `bot-1` never answers for a new `bot-1`.
 */
export function apiKeyCreateRequestId(
  userId: string,
  listed: readonly { id: string; revoked: boolean }[],
  input: Omit<ApiKeyCreateInput, 'requestId'>,
): string {
  const seen = [...listed]
    .map((key) => `${key.id}:${key.revoked ? 1 : 0}`)
    .sort()
    .join(',');
  const asked = JSON.stringify([input.name, [...input.scopes].sort(), [...(input.ips ?? [])].sort(), input.expiresAt ?? null]);
  return `api-key-create:${userId.toLowerCase()}:${digest(seen)}:${digest(asked)}`;
}
