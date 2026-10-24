import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { createMinimalOriginalJournal, type JournalPorts } from '../../shared/minimal-original-journal';
import type { ApiKeyRecord } from './api-key-records-api';

const uuid = z.string().guid();
const timestamp = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
const originalSchema = z
  .object({
    kind: z.literal('api-key-revoke'),
    owner: uuid,
    keyId: uuid,
    originalId: uuid,
    createdAt: timestamp,
  })
  .strict();
export type ApiKeyRevokeOriginal = Readonly<z.infer<typeof originalSchema>>;

// List IDs are published as arbitrary strings. Only the exact UUID accepted
// by the mounted write contract is eligible; names/prefixes are never targets.
export function canReviewApiKeyRevoke(record: ApiKeyRecord): boolean {
  return !record.revoked && uuid.safeParse(record.id).success;
}

export function apiKeyRevokeStorageKey(owner: string): string {
  return `intafaced.customer.api-key-revoke.v1:${uuid.parse(owner)}`;
}

export function decodeApiKeyRevokeOriginal(raw: string, owner: string): ApiKeyRevokeOriginal {
  const original = originalSchema.parse(JSON.parse(raw));
  if (original.owner !== uuid.parse(owner)) throw new TypeError('Original owner does not match');
  return Object.freeze(original);
}

export function createApiKeyRevokeJournal(owner: string, ports: JournalPorts) {
  return createMinimalOriginalJournal(apiKeyRevokeStorageKey(owner), (raw) => decodeApiKeyRevokeOriginal(raw, owner), ports);
}

const resultSchema = z.object({ revoked: z.boolean() }).strict();
export type ApiKeyRevokeResult = z.infer<typeof resultSchema>;

export async function revokeApiKey(api: ApiClient, keyId: string, signal: AbortSignal): Promise<ApiResult<ApiKeyRevokeResult>> {
  // Original identity is local only. No operation ID/idempotency protocol is
  // mounted here; do not put local correlation or an owner into the wire body.
  return api.mutate('identity', 'apiKeys.revoke', { keyId: uuid.parse(keyId) }, resultSchema, { signal });
}

export type DirectApiKeyRevokeProof = 'marked-revoked' | 'no-matching-change' | 'denied-before-effect';

/** Caller must bind this direct response to the original, current request.
 * A later list row is current state, and cannot supply this attempt's proof.
 */
export function directApiKeyRevokeProof(result: ApiResult<ApiKeyRevokeResult>): DirectApiKeyRevokeProof | null {
  if (result.ok) return result.data.revoked ? 'marked-revoked' : 'no-matching-change';
  return result.reason === 'forbidden' && result.status === 403 && result.code === 'scope.denied' ? 'denied-before-effect' : null;
}
