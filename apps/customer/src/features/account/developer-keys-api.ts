import {
  apiKeyCreateOutputSchema,
  apiKeyCreateRequestId,
  apiKeyDetailSchema,
  apiKeyListOutputSchema,
  apiKeyRevokeOutputSchema,
  apiKeyScopesOutputSchema,
  apiKeySetExpiryOutputSchema,
  type ApiKeyCreateInput,
  type ApiKeyCreateOutput,
  type ApiKeyDetail,
  type ApiKeyList,
  type ApiKeyRecord,
  type ApiKeyRevokeOutput,
  type ApiKeyScopeEntry,
} from '@intafaced/contracts/api-keys';
import type { ApiClient, ApiResult } from '../../shared/api';
import { requestPasskeyAssertion } from '../session/webauthn';
import type { ApiKeysCopyKey } from './api-keys-copy';

/** The most keys the room reads at once; the owner's cap is far below it. */
const LIST_LIMIT = 200;

export function readDeveloperKeys(api: ApiClient, signal: AbortSignal): Promise<ApiResult<ApiKeyList>> {
  return api.query('identity', 'developerKeys.list', { limit: LIST_LIMIT }, apiKeyListOutputSchema, { signal });
}

export function readKeyScopes(api: ApiClient, signal: AbortSignal): Promise<ApiResult<{ scopes: ApiKeyScopeEntry[] }>> {
  return api.query('identity', 'developerKeys.scopes', undefined, apiKeyScopesOutputSchema, { signal });
}

export type Preset = 'read' | 'trade' | 'custom';

/** The scopes a preset ticks, from those this sign-in may put on a key. */
export function presetScopes(preset: Exclude<Preset, 'custom'>, offered: readonly ApiKeyScopeEntry[]): string[] {
  const allowed = offered.filter((entry) => entry.onKey);
  if (preset === 'read') return allowed.filter((entry) => entry.access === 'read').map((entry) => entry.scope);
  return allowed.filter((entry) => entry.scope === 'trade:read' || entry.scope === 'trade:write').map((entry) => entry.scope);
}

/** One address per line; blank lines dropped. The service checks each one. */
export const ipLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** A chosen calendar day (`YYYY-MM-DD`) becomes the first instant of the next day, UTC: the key works through that day. */
export function endOfDayUtc(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start)) return undefined;
  return new Date(start + 86_400_000).toISOString();
}

export type Factor = { code: string } | { passkey: true } | null;

async function proofFor(api: ApiClient, factor: Factor, signal?: AbortSignal) {
  if (factor && 'code' in factor) return { ok: true as const, proof: { totpCode: factor.code } };
  if (factor && 'passkey' in factor) {
    const assertion = await requestPasskeyAssertion(api, signal);
    if (!assertion.ok) return assertion;
    return { ok: true as const, proof: { webauthn: assertion.data } };
  }
  return { ok: true as const, proof: undefined };
}

/** One key with its IP policy and the owner's idle period (`/uc/safe/api-keys/:keyId`). */
export function readDeveloperKey(api: ApiClient, keyId: string, signal: AbortSignal): Promise<ApiResult<ApiKeyDetail>> {
  return api.query('identity', 'developerKeys.get', { keyId }, apiKeyDetailSchema, { signal });
}

/** The person's own revoke: never a second factor, so a key can always be switched off. A blank reason is none. */
export function revokeDeveloperKey(
  api: ApiClient,
  keyId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<ApiResult<ApiKeyRevokeOutput>> {
  const trimmed = reason.trim();
  return api.mutate('identity', 'developerKeys.revoke', { keyId, ...(trimmed ? { reason: trimmed } : {}) }, apiKeyRevokeOutputSchema, {
    signal,
  });
}

/**
 * A new end date. Without a factor the service takes only an earlier one (or a first one); a later one answers
 * `auth.step_up_required` until it is sent again with a passkey or a code.
 */
export async function setDeveloperKeyExpiry(
  api: ApiClient,
  keyId: string,
  expiresAt: string,
  factor: Factor,
  signal?: AbortSignal,
): Promise<ApiResult<{ record: ApiKeyRecord }>> {
  const proof = await proofFor(api, factor, signal);
  if (!proof.ok) return proof;
  return api.mutate(
    'identity',
    'developerKeys.setExpiry',
    { keyId, expiresAt, ...(proof.proof ? { factorProof: proof.proof } : {}) },
    apiKeySetExpiryOutputSchema,
    { signal, keepSessionFor: ['auth.mfa_invalid', 'auth.webauthn_invalid'] },
  );
}

/** The last calendar day (UTC, `YYYY-MM-DD`) a key with this end instant works on: an end at midnight is the day before. */
export function lastDayUtc(expiresAt: string): string {
  return new Date(Date.parse(expiresAt) - 1).toISOString().slice(0, 10);
}

/** Whole days in the owner's idle period, rounded down; a period under a day reads as 0. */
export const idleDays = (seconds: number): number => Math.floor(seconds / 86_400);

/**
 * Sends one create. The request id comes from the list this form read and the key asked for, so pressing Create again
 * after a lost reply returns the key that request made. With no factor the service answers `auth.step_up_required`.
 */
export async function createDeveloperKey(
  api: ApiClient,
  userId: string,
  listed: ApiKeyList['keys'],
  asked: Omit<ApiKeyCreateInput, 'requestId'>,
  factor: Factor,
  signal?: AbortSignal,
): Promise<ApiResult<ApiKeyCreateOutput>> {
  const proof = await proofFor(api, factor, signal);
  if (!proof.ok) return proof;
  const factorProof = proof.proof;
  const requestId = apiKeyCreateRequestId(userId, listed, asked);
  return api.mutate(
    'identity',
    'developerKeys.create',
    { ...asked, requestId, ...(factorProof ? { factorProof } : {}) },
    apiKeyCreateOutputSchema,
    { signal, keepSessionFor: ['auth.mfa_invalid', 'auth.webauthn_invalid'] },
  );
}

const REFUSALS = new Set<string>([
  'auth.step_up_required',
  'auth.step_up_expired',
  'auth.mfa_invalid',
  'auth.webauthn_invalid',
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
  'identity.delegated_refused',
  'auth.passkey_missing',
  'auth.passkey_verify_unavailable',
]);

const CHANGE_REFUSALS = new Set<string>([
  'auth.step_up_required',
  'auth.step_up_expired',
  'auth.mfa_invalid',
  'auth.webauthn_invalid',
  'auth.delegate_cannot_grant',
  'identity.key_not_found',
  'identity.key_not_live',
  'identity.key_expiry_invalid',
  'identity.key_revoke_reason_invalid',
  'identity.delegated_refused',
]);

/** The detail page's and the revoke dialog's sentence for a typed refusal, or null for the shared failure panel. */
export function changeRefusal(
  result: Extract<ApiResult<unknown>, { ok: false }>,
): Extract<ApiKeysCopyKey, `changeRefused.${string}`> | null {
  return result.code && CHANGE_REFUSALS.has(result.code)
    ? (`changeRefused.${result.code}` as Extract<ApiKeysCopyKey, `changeRefused.${string}`>)
    : null;
}

/** The room's own sentence for a typed refusal, or null for anything else (shown by the shared failure panel). */
export function createRefusal(result: Extract<ApiResult<unknown>, { ok: false }>): Extract<ApiKeysCopyKey, `refused.${string}`> | null {
  return result.code && REFUSALS.has(result.code) ? (`refused.${result.code}` as Extract<ApiKeysCopyKey, `refused.${string}`>) : null;
}

/** A small text file a program can load, built in the browser from the reply and never stored. */
export function environmentFile(key: string): string {
  return `# API key for your program. Keep this file out of source control.\nINTAFACED_API_KEY=${key}\n`;
}
