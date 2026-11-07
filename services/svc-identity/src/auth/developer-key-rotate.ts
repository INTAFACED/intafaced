/**
 * Rotate one of the person's live keys with an overlap (DV-keys-04, J-developer-07 #1 #2). The replacement keeps the
 * old key's name, permissions, IP list, end date and signing; the old key keeps working for the overlap (its end date
 * moves to the overlap's end, never later) and stops at once with an overlap of 0. The overlap is capped by the owner's
 * maximum; while that is blank, any overlap above 0 refuses. A key is replaced at most once: a rotation retried after a
 * lost reply answers with the replacement already made, without its secret, and mints nothing.
 */
import type { ApiKeyRotateInput, ApiKeyRotateOutput } from '@intafaced/contracts/api-keys';
import type { Sql } from 'postgres';
import type { PayStepUpFactorProof } from './auth-service.js';
import { guardedApiKeyAction } from './api-key-fresh-factor.js';
import { DeveloperKeyError, KEY_COLUMNS, notFound, toRecord, type Caller, type DeveloperKeysDeps } from './developer-keys.js';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { rotateApiKey, RotateApiKeyError } from './rotate-api-key.js';

/** `IDENTITY_API_KEY_ROTATE_OVERLAP_MAX_SECONDS`: whole seconds, or null when blank. Anything else stops the service. */
export function parseRotateOverlapMaxSeconds(raw: string | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!text) return null;
  if (!/^[1-9]\d{0,7}$/.test(text))
    throw new Error('IDENTITY_API_KEY_ROTATE_OVERLAP_MAX_SECONDS must be a whole number of seconds above 0');
  return Number(text);
}

class AlreadyRotated extends Error {}

type KeyRow = Parameters<typeof toRecord>[0];

/** The replacement already made for `keyId`, as the reply to a repeat, or null. */
async function replacementOf(sql: Sql, userId: string, keyId: string): Promise<ApiKeyRotateOutput | null> {
  const rows = await sql<Array<KeyRow & { old_expires_at: Date | null; old_revoked_at: Date | null }>>`
    SELECT ${sql.unsafe(
      KEY_COLUMNS.split(', ')
        .map((c) => `n.${c}`)
        .join(', '),
    )},
           o.expires_at AS old_expires_at, o.revoked_at AS old_revoked_at
    FROM api_keys n JOIN api_keys o ON o.id = n.rotated_from
    WHERE n.rotated_from = ${keyId} AND n.user_id = ${userId} AND o.user_id = ${userId}
  `;
  const row = rows[0];
  if (!row) return null;
  const endsAt = row.old_revoked_at ?? row.old_expires_at ?? row.created_at;
  return { record: toRecord(row), key: null, signingSecret: null, replaced: { id: keyId, endsAt: endsAt.toISOString() }, replayed: true };
}

export async function rotateDeveloperKey(
  deps: DeveloperKeysDeps,
  caller: Caller,
  input: ApiKeyRotateInput & { factorProof?: PayStepUpFactorProof | undefined },
  /** Runs inside the rotation's transaction once the replacement exists (a rotation request marks itself approved). */
  onRotated?: (tx: Sql, replacementId: string) => Promise<void>,
): Promise<ApiKeyRotateOutput> {
  const now = deps.now?.() ?? new Date();
  const repeat = await replacementOf(deps.sql, caller.userId, input.keyId);
  if (repeat) return repeat;
  if (input.overlapSeconds > 0) {
    const max = deps.rotateOverlapMaxSeconds ?? null;
    if (max === null) {
      throw new DeveloperKeyError('The longest rotation overlap is not set', 'identity.key_rotate_overlap_unset');
    }
    if (input.overlapSeconds > max)
      throw new DeveloperKeyError('That overlap is longer than the longest allowed', 'identity.key_rotate_overlap_too_long');
  }
  const [own] = await deps.sql<Array<{ revoked: boolean; expires_at: Date | null }>>`
    SELECT revoked, expires_at FROM api_keys WHERE id = ${input.keyId} AND user_id = ${caller.userId}
  `;
  if (!own) throw notFound();
  if (own.revoked || (own.expires_at && own.expires_at.getTime() <= now.getTime())) {
    throw new DeveloperKeyError('This key is revoked or has ended; make a new key instead', 'identity.key_not_live');
  }
  try {
    return await guardedApiKeyAction(deps.gate, caller, input.factorProof, { action: 'rotate', keyId: input.keyId }, async (scope) => {
      const tx = scope.tx;
      // One rotation of a key at a time: the second waits here and then finds the first one's replacement.
      await tx`SELECT id FROM api_keys WHERE id = ${input.keyId} AND user_id = ${caller.userId} FOR UPDATE`;
      if ((await tx`SELECT 1 FROM api_keys WHERE rotated_from = ${input.keyId}`).length > 0) throw new AlreadyRotated();
      const [user] = await tx<Array<{ webauthn_creds: unknown }>>`SELECT webauthn_creds FROM users WHERE id = ${caller.userId}`;
      requireVerifiedPasskey(user?.webauthn_creds);
      const rotated = await rotateApiKey(
        scope,
        tx,
        { userId: caller.userId, keyId: input.keyId, grantorScopes: caller.scopes, grantorKid: caller.kid ?? null },
        deps.signingEncKey ?? null,
        { overlapSeconds: input.overlapSeconds, now },
      );
      if (onRotated) await onRotated(tx, rotated.id);
      const rows = await tx<KeyRow[]>`SELECT ${tx.unsafe(KEY_COLUMNS)} FROM api_keys WHERE id = ${rotated.id}`;
      return {
        record: toRecord(rows[0]!),
        key: rotated.key,
        signingSecret: rotated.signingSecret,
        replaced: { id: input.keyId, endsAt: rotated.endsAt.toISOString() },
        replayed: false,
      };
    });
  } catch (err) {
    if (err instanceof AlreadyRotated) {
      const raced = await replacementOf(deps.sql, caller.userId, input.keyId);
      if (raced) return raced;
    }
    if (err instanceof RotateApiKeyError) {
      if (err.code === 'auth.not_configured') {
        throw new DeveloperKeyError('Keys that place orders sign every request, and signing is not set up', 'identity.key_signing_unset');
      }
      throw notFound();
    }
    throw err;
  }
}
