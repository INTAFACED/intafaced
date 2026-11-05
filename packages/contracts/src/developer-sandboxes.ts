/**
 * Named developer sandboxes and their keys (`/developers/sandbox`, DV-sandbox-01, journey J-developer-02 #2 and #3).
 *
 * A sandbox is a named place for TEST work on one account. Every account may hold one; a second and later one needs
 * the owner's sandbox count cap for the account's verification level, and a blank cap refuses
 * `identity.sandbox_cap_unset`. A sandbox key is an API key whose environment is `sandbox` from birth and never
 * changes: the door serves it only at the sandbox host. It may hold sandbox-safe scopes only; a trade or any other
 * scope refuses `env.scope_not_sandboxable`, and nothing is made.
 *
 * Browser-safe: zod only. The service adds its own second-factor field to the key create input.
 */
import { z } from 'zod';
import { apiKeyCreateInputSchema, apiKeyRecordSchema, apiKeyRequestIdSchema } from './api-keys.js';

export const SANDBOX_NAME_MAX = 40;
/** The scopes a sandbox can serve: its own TEST payments, read and write. Nothing else goes on a sandbox key. */
export const SANDBOX_KEY_SCOPES = ['pay:read', 'pay:write'] as const;
export type SandboxKeyScope = (typeof SANDBOX_KEY_SCOPES)[number];

export const isSandboxKeyScope = (scope: string): scope is SandboxKeyScope => (SANDBOX_KEY_SCOPES as readonly string[]).includes(scope);

/** Typed refusals of the sandbox create door (`data.cause.code`). */
export const SANDBOX_CREATE_REFUSALS = [
  'identity.sandbox_name_invalid',
  'identity.sandbox_name_taken',
  'identity.sandbox_cap_unset',
  'identity.sandbox_cap_reached',
  'identity.sandbox_request_conflict',
] as const;
export type SandboxCreateRefusal = (typeof SANDBOX_CREATE_REFUSALS)[number];

/** Typed refusals of the sandbox key door, on top of the key door's own (`API_KEY_CREATE_REFUSALS`). */
export const SANDBOX_KEY_REFUSALS = ['env.scope_not_sandboxable', 'identity.sandbox_not_found'] as const;
export type SandboxKeyRefusal = (typeof SANDBOX_KEY_REFUSALS)[number];

const isoInstant = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}, 'ISO instant');

export const sandboxCreateInputSchema = z
  .object({
    requestId: apiKeyRequestIdSchema,
    name: z.string().max(SANDBOX_NAME_MAX * 4),
  })
  .strict();
export type SandboxCreateInput = z.infer<typeof sandboxCreateInputSchema>;

export const sandboxRecordSchema = z
  .object({
    id: z.string().guid(),
    name: z.string(),
    createdAt: isoInstant,
  })
  .strict();
export type SandboxRecord = z.infer<typeof sandboxRecordSchema>;

export const sandboxCreateOutputSchema = z.object({ sandbox: sandboxRecordSchema, replayed: z.boolean() }).strict();
export type SandboxCreateOutput = z.infer<typeof sandboxCreateOutputSchema>;

/**
 * How many sandboxes this account may hold. `limit: null` means the owner has not set a cap for its level: the first
 * sandbox is still allowed, and a second refuses `identity.sandbox_cap_unset`.
 */
export const sandboxCapSchema = z.object({ limit: z.number().int().min(0).nullable(), held: z.number().int().min(0) }).strict();
export type SandboxCap = z.infer<typeof sandboxCapSchema>;

/** Where a sandbox key is served. Null: the owner has not set the sandbox host, and the room says so. */
const baseUrlSchema = z.string().url().nullable();

export const sandboxListOutputSchema = z
  .object({ sandboxes: z.array(sandboxRecordSchema).max(200), cap: sandboxCapSchema, baseUrl: baseUrlSchema })
  .strict();
export type SandboxList = z.infer<typeof sandboxListOutputSchema>;

export const sandboxGetInputSchema = z.object({ sandboxId: z.string().guid() }).strict();
export const sandboxGetOutputSchema = z
  .object({ sandbox: sandboxRecordSchema, keys: z.array(apiKeyRecordSchema).max(200), baseUrl: baseUrlSchema })
  .strict();
export type SandboxDetail = z.infer<typeof sandboxGetOutputSchema>;

/** A sandbox key create: the key door's own input (name, scopes, IPs, end date) and the sandbox it belongs to. */
export const sandboxKeyCreateInputSchema = apiKeyCreateInputSchema.extend({ sandboxId: z.string().guid() }).strict();
export type SandboxKeyCreateInput = z.infer<typeof sandboxKeyCreateInputSchema>;

export const sandboxKeyCreateOutputSchema = z
  .object({
    record: apiKeyRecordSchema,
    /** The key, in this reply only. Null when this reply answers a repeat of the same request id. */
    key: z.string().nullable(),
    replayed: z.boolean(),
    baseUrl: baseUrlSchema,
  })
  .strict();
export type SandboxKeyCreateOutput = z.infer<typeof sandboxKeyCreateOutputSchema>;

/**
 * Sandbox test funds (DV-sandbox-02, J-developer-02 #4, #5, #8), served by svc-pay at `sandboxFunds.*`.
 *
 * The balances live in svc-pay's own sandbox store, which holds TEST figures only: nothing in it is posted to the
 * ledger, read from it or moved to real funds (the lead's ruling of 2026-10-30). Each press of Fund adds the owner's
 * TEST amount per press; while that is blank, Fund refuses `pay.sandbox_funds_unset` and nothing is written. Reset sets
 * the sandbox's balances back to zero, up to the owner's resets per day; a blank cap refuses
 * `pay.sandbox_reset_cap_unset` and a spent one `pay.sandbox_reset_cap_reached`.
 *
 * `version` counts the funds and resets the sandbox has had. The page sends it back inside the next request id, so a
 * double press is one change and a press after a reset is a new one.
 */
export const SANDBOX_FUND_ASSET = 'USDT';
export const SANDBOX_FUND_REFUSALS = [
  'pay.sandbox_funds_unset',
  'pay.sandbox_reset_cap_unset',
  'pay.sandbox_reset_cap_reached',
  'pay.sandbox_request_conflict',
] as const;
export type SandboxFundRefusal = (typeof SANDBOX_FUND_REFUSALS)[number];

/** A TEST figure as a decimal string, never a number. */
const sandboxDecimalSchema = z.string().regex(/^\d{1,20}(\.\d{1,18})?$/);

export const sandboxBalanceInputSchema = z.object({ sandboxId: z.string().guid() }).strict();
export type SandboxBalanceInput = z.infer<typeof sandboxBalanceInputSchema>;
export const sandboxBalanceOutputSchema = z
  .object({
    sandboxId: z.string().guid(),
    label: z.literal('TEST'),
    asset: z.literal(SANDBOX_FUND_ASSET),
    amount: sandboxDecimalSchema,
    version: z.number().int().nonnegative(),
    /** The owner's TEST amount each Fund adds; null while blank. */
    fundAmount: sandboxDecimalSchema.nullable(),
    /** The owner's resets per day; null while blank. */
    resetsPerDay: z.number().int().positive().nullable(),
    resetsToday: z.number().int().nonnegative(),
  })
  .strict();
export type SandboxBalance = z.infer<typeof sandboxBalanceOutputSchema>;
/** A Fund or Reset answer: the balance after it, and whether this request id had already been answered (nothing changed). */
const sandboxChangeOutputSchema = sandboxBalanceOutputSchema.extend({ replayed: z.boolean() }).strict();
export type SandboxChange = z.infer<typeof sandboxChangeOutputSchema>;

export const sandboxFundInputSchema = z.object({ sandboxId: z.string().guid(), requestId: apiKeyRequestIdSchema }).strict();
export type SandboxFundInput = z.infer<typeof sandboxFundInputSchema>;
export const sandboxFundOutputSchema = sandboxChangeOutputSchema;
export const sandboxResetInputSchema = sandboxFundInputSchema;
export type SandboxResetInput = z.infer<typeof sandboxResetInputSchema>;
export const sandboxResetOutputSchema = sandboxChangeOutputSchema;

/**
 * The sandbox's card test values (`/developers/sandbox/test-values`, J-developer-02 #8): instrument tokens that steer
 * the sandbox card rail the way a real sandbox uses test card numbers. svc-pay's card-sandbox rail answers each one
 * (services/svc-pay/src/rails/card-sandbox.ts; a svc-pay test holds the two lists equal). Any other token approves.
 */
export const SANDBOX_CARD_TEST_VALUES = [
  { id: 'decline', token: 'tok_decline', status: 'failed', failureCode: 'card.declined' },
  { id: 'acquirer_outage', token: 'tok_rail_error', status: 'failed', failureCode: 'acquirer.unavailable' },
  { id: 'funds_held', token: 'tok_funds_held', status: 'authorized', failureCode: null },
] as const;
export type SandboxCardTestValue = (typeof SANDBOX_CARD_TEST_VALUES)[number];

/** FNV-1a, 64 bits, as in `api-keys.ts`: a short stable digest. */
function digest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const unit of new TextEncoder().encode(text)) {
    hash ^= BigInt(unit);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * The request id of one sandbox create: a business key, never random. It names the person, the sandboxes they last
 * read and the name asked for, so a retry after a lost reply answers with the same sandbox, and a new name or a
 * changed list makes a new id.
 */
export function sandboxCreateRequestId(userId: string, listed: readonly { id: string }[], name: string): string {
  const seen = listed
    .map((sandbox) => sandbox.id)
    .sort()
    .join(',');
  return `sandbox-create:${userId.toLowerCase()}:${digest(seen)}:${digest(name.trim().toLowerCase())}`;
}

/** The request id of one press of Fund: the person, the sandbox and the balance version the page read. */
export function sandboxFundRequestId(userId: string, sandboxId: string, version: number): string {
  return `sandbox-fund:${userId.toLowerCase()}:${sandboxId.toLowerCase()}:v${version}`;
}

/** The request id of one press of Reset, read the same way. */
export function sandboxResetRequestId(userId: string, sandboxId: string, version: number): string {
  return `sandbox-reset:${userId.toLowerCase()}:${sandboxId.toLowerCase()}:v${version}`;
}

/** The request id of one sandbox key create: the sandbox, the keys it last listed and the key asked for. */
export function sandboxKeyCreateRequestId(
  userId: string,
  sandboxId: string,
  listed: readonly { id: string; revoked: boolean }[],
  input: { name: string; scopes: readonly string[]; ips?: readonly string[]; expiresAt?: string },
): string {
  const seen = [...listed]
    .map((key) => `${key.id}:${key.revoked ? 1 : 0}`)
    .sort()
    .join(',');
  const asked = JSON.stringify([input.name, [...input.scopes].sort(), [...(input.ips ?? [])].sort(), input.expiresAt ?? null]);
  return `sandbox-key-create:${userId.toLowerCase()}:${sandboxId.toLowerCase()}:${digest(seen)}:${digest(asked)}`;
}
