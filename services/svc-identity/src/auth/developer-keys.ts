/**
 * Personal API keys made in the developer room (DV-keys-01, the list half of DV-keys-03; journey J-developer-03).
 *
 * One create applies the whole policy: a non-empty list of scopes a key may hold, a name unique on the account without
 * regard to case, literal IP addresses, an end date in the future, the owner's key cap for the account's verification
 * level, and a fresh second factor. The checks that need no factor run first, so a refused form never spends a code.
 * The name, the cap and the request id are checked again inside the factor's transaction, under the account row lock,
 * so two creates at once cannot both pass.
 *
 * The request id is the business key. A repeat answers with the stored record and no secret, with no second factor
 * (it reveals only what the list already shows); the same id with a different key asked for refuses.
 *
 * A key that may place orders (`trade:write`) signs every request by default (DV-auth-01): it is minted with
 * `require_signature` on and a signing secret sealed at rest, in the same transaction, and the secret is shown once
 * beside the key. With no sealing key configured such a create refuses `identity.key_signing_unset` before the factor
 * is spent; there is never a moment the key exists unsigned.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { FOUNDER_DESK_SCOPES, INTERACTIVE_ONLY_SCOPES, SCOPES, expandScopes, isPayStepUpScope, isScope, type Scope } from '@intafaced/auth';
import type { ApiKeyCreateInput, ApiKeyCreateOutput, ApiKeyList, ApiKeyRecord, ApiKeyScopeEntry } from '@intafaced/contracts/api-keys';
import { API_KEY_NAME_MAX, API_KEY_SIGNED_BY_DEFAULT_SCOPE } from '@intafaced/contracts/api-keys';
import type { KycTier, PayStepUpFactorProof } from './auth-service.js';
import { bindApiKeyIpAllowlist } from './auth-service-ip.js';
import { normalizeIp } from './api-key-ip.js';
import { guardedApiKeyAction, type ApiKeyFactorGate } from './api-key-fresh-factor.js';
import { issueSigningSecret, sealSigningSecret } from './api-key-request-sign.js';
import { MintApiKeyPasskeyError, requireVerifiedPasskey } from './mint-api-key-passkey.js';

export type DeveloperKeyRefusal =
  | 'auth.scope_empty'
  | 'auth.scope_unknown'
  | 'auth.scope_interactive_only'
  | 'auth.scope_not_held'
  | 'auth.ip_invalid'
  | 'identity.key_name_invalid'
  | 'identity.key_name_taken'
  | 'identity.key_expiry_invalid'
  | 'identity.key_cap_unset'
  | 'identity.key_cap_reached'
  | 'identity.key_request_conflict'
  | 'identity.key_signing_unset';

export class DeveloperKeyError extends Error {
  constructor(
    message: string,
    readonly code: DeveloperKeyRefusal,
  ) {
    super(message);
    this.name = 'DeveloperKeyError';
  }
}

const TIERS: readonly KycTier[] = ['none', 'basic', 'full', 'institutional'];

/**
 * `IDENTITY_API_KEYS_MAX_BY_TIER`: the owner's key cap per verification level, `tier=count` pairs joined by commas
 * (`basic=3,full=5`). Blank: null, and every create refuses `identity.key_cap_unset`. A level left out has no cap set
 * and refuses the same way. A malformed value throws, so the service does not start on a cap it cannot read.
 */
export function parseApiKeyCapByTier(raw: string | undefined): ReadonlyMap<KycTier, number> | null {
  if (raw === undefined || raw.trim() === '') return null;
  const caps = new Map<KycTier, number>();
  for (const part of raw.split(',')) {
    const match = /^\s*([a-z]+)\s*=\s*(\d{1,4})\s*$/.exec(part);
    const tier = match?.[1] as KycTier | undefined;
    if (!match || !tier || !TIERS.includes(tier) || caps.has(tier)) {
      throw new Error('IDENTITY_API_KEYS_MAX_BY_TIER must be tier=count pairs (none, basic, full, institutional), each tier once');
    }
    caps.set(tier, Number(match[2]));
  }
  return caps;
}

/** Why a scope the session holds cannot sit on a key, or null when it can. */
function blockOf(scope: Scope): ApiKeyScopeEntry['blockedBy'] {
  if ((INTERACTIVE_ONLY_SCOPES as readonly string[]).includes(scope)) return 'interactive_only';
  if ((FOUNDER_DESK_SCOPES as readonly string[]).includes(scope)) return 'operator_only';
  if (isPayStepUpScope(scope)) return 'step_up_only';
  return null;
}

/**
 * The scopes this signed-in session could put on a key, and the ones a key never holds, with the reason: every
 * customer interactive-only scope (withdraw, card, onboarding) whether or not this sign-in holds it now, so the room
 * can say why. Operator scopes are left out unless this sign-in holds them.
 * Other scopes the session does not hold are left out: a key never holds more than the person who made it.
 */
export function describeKeyScopes(sessionScopes: readonly string[]): ApiKeyScopeEntry[] {
  const held = expandScopes(sessionScopes);
  const out: ApiKeyScopeEntry[] = [];
  for (const scope of SCOPES) {
    const blockedBy = blockOf(scope);
    const explained =
      blockedBy === 'interactive_only' && !scope.startsWith('admin:') && !(FOUNDER_DESK_SCOPES as readonly string[]).includes(scope);
    if (!held.has(scope) && !explained) continue;
    out.push({ scope, access: scope.endsWith(':read') ? 'read' : 'write', onKey: blockedBy === null, blockedBy });
  }
  return out;
}

const NAME = new RegExp(`^[^\\p{Cc}\\p{Cf}]{1,${API_KEY_NAME_MAX}}$`, 'u');

type Checked = { name: string; scopes: string[]; ips: string[]; expiresAt: Date | null; fingerprint: string };

/** Everything that needs no second factor and no lock. Throws the first refusal. */
export function checkCreate(input: Omit<ApiKeyCreateInput, 'requestId'>, sessionScopes: readonly string[], now: Date): Checked {
  const name = input.name.trim();
  if (!NAME.test(name))
    throw new DeveloperKeyError('Use a key name of 1 to 64 characters, with no control characters', 'identity.key_name_invalid');
  const scopes = [...new Set(input.scopes)].sort();
  if (scopes.length === 0) throw new DeveloperKeyError('Choose at least one permission for the key', 'auth.scope_empty');
  if (scopes.some((scope) => !isScope(scope))) throw new DeveloperKeyError('A permission on this key does not exist', 'auth.scope_unknown');
  if (scopes.some((scope) => blockOf(scope as Scope) !== null)) {
    // Interactive-only, merchant step-up and operator scopes alike: none of them goes on a key made in this room.
    throw new DeveloperKeyError('A permission you chose cannot be put on a key made here', 'auth.scope_interactive_only');
  }
  const held = expandScopes(sessionScopes);
  if (scopes.some((scope) => !held.has(scope as Scope))) {
    throw new DeveloperKeyError('A key cannot hold a permission your sign-in does not have', 'auth.scope_not_held');
  }
  const ips: string[] = [];
  for (const raw of input.ips ?? []) {
    const ip = normalizeIp(raw);
    if (!ip) throw new DeveloperKeyError('Enter single IPv4 or IPv6 addresses', 'auth.ip_invalid');
    if (!ips.includes(ip)) ips.push(ip);
  }
  ips.sort();
  let expiresAt: Date | null = null;
  if (input.expiresAt !== undefined) {
    expiresAt = new Date(input.expiresAt);
    if (!(expiresAt.getTime() > now.getTime()))
      throw new DeveloperKeyError('Choose an end date in the future', 'identity.key_expiry_invalid');
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([name, scopes, ips, expiresAt?.toISOString() ?? null]))
    .digest('hex');
  return { name, scopes, ips, expiresAt, fingerprint };
}

type KeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  mode: string;
  scopes: string[];
  ip_allowlist: string[] | null;
  require_signature: boolean | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked: boolean;
};

function toRecord(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    mode: row.mode === 'sandbox' ? 'sandbox' : 'live',
    scopes: row.scopes,
    ipAllowlist: row.ip_allowlist ?? [],
    requireSignature: row.require_signature === true,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revoked: row.revoked,
  };
}

async function liveKeyCount(sql: Sql, userId: string): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM api_keys
    WHERE user_id = ${userId} AND revoked = false AND (expires_at IS NULL OR expires_at > now())
  `;
  return rows[0]?.n ?? 0;
}

export type DeveloperKeysDeps = {
  sql: Sql;
  gate: ApiKeyFactorGate;
  kycTier: (userId: string, sql?: Sql) => Promise<KycTier>;
  capByTier: ReadonlyMap<KycTier, number> | null;
  /**
   * The service's own rule for who may hold a key at all (on the live service: an enrolled, verified passkey,
   * `requireVerifiedPasskey`). Asked before the factor is spent, with the kind of factor sent (a passkey assertion
   * verifies the passkey on its way in); the mint itself checks it again.
   */
  mayMint?: (userId: string, factor: 'passkey' | 'other' | 'none') => Promise<void>;
  /** Seals a signing key's secret at rest (`API_KEY_SIGNING_ENC_KEY`). Null or absent: a signing key refuses. */
  signingEncKey?: Buffer | null;
  now?: () => Date;
};

/** Whether a key with these scopes signs every request by default. */
export function signsByDefault(scopes: readonly string[]): boolean {
  return expandScopes(scopes).has(API_KEY_SIGNED_BY_DEFAULT_SCOPE);
}

type Caller = { userId: string; sid: string; kid?: string | undefined; sub_account?: string | undefined; scopes: readonly string[] };

async function capFor(deps: DeveloperKeysDeps, userId: string, sql: Sql): Promise<number | null> {
  if (!deps.capByTier) return null;
  return deps.capByTier.get(await deps.kycTier(userId, sql)) ?? null;
}

async function replayOf(sql: Sql, userId: string, requestId: string, fingerprint: string): Promise<ApiKeyCreateOutput | null> {
  const rows = await sql<Array<KeyRow & { fingerprint: string }>>`
    SELECT r.fingerprint, k.id, k.name, k.key_prefix, k.mode, k.scopes, k.ip_allowlist, k.require_signature,
           k.created_at, k.expires_at, k.last_used_at, k.revoked
    FROM api_key_create_requests r JOIN api_keys k ON k.id = r.key_id AND k.user_id = r.user_id
    WHERE r.user_id = ${userId} AND r.request_id = ${requestId}
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.fingerprint !== fingerprint) {
    throw new DeveloperKeyError('This request id was already used for a different key', 'identity.key_request_conflict');
  }
  return { record: toRecord(row), key: null, signingSecret: null, replayed: true };
}

class SameRequestRace extends Error {}

async function assertNameFree(sql: Sql, userId: string, name: string): Promise<void> {
  const taken = await sql<Array<{ id: string }>>`
    SELECT id FROM api_keys
    WHERE user_id = ${userId} AND revoked = false AND (expires_at IS NULL OR expires_at > now()) AND lower(name) = lower(${name})
    LIMIT 1
  `;
  if (taken[0]) throw new DeveloperKeyError('You already have a key with this name', 'identity.key_name_taken');
}

async function assertUnderCap(deps: DeveloperKeysDeps, userId: string, sql: Sql): Promise<void> {
  const cap = await capFor(deps, userId, sql);
  if (cap === null) throw new DeveloperKeyError('The number of API keys an account may hold is not set', 'identity.key_cap_unset');
  if ((await liveKeyCount(sql, userId)) >= cap) {
    throw new DeveloperKeyError('This account holds as many API keys as it may', 'identity.key_cap_reached');
  }
}

export async function createDeveloperKey(
  deps: DeveloperKeysDeps,
  caller: Caller,
  input: ApiKeyCreateInput & { factorProof?: PayStepUpFactorProof | undefined },
): Promise<ApiKeyCreateOutput> {
  const now = deps.now?.() ?? new Date();
  const checked = checkCreate(input, caller.scopes, now);
  const replay = await replayOf(deps.sql, caller.userId, input.requestId, checked.fingerprint);
  if (replay) return replay;
  // The name and the cap are checked before the factor is spent, so a refused form keeps its code. Both are decided
  // again under the lock below, which is the check that holds when two creates race.
  try {
    await assertNameFree(deps.sql, caller.userId, checked.name);
    await assertUnderCap(deps, caller.userId, deps.sql);
  } catch (err) {
    // The twin of this request may have committed since the replay read: its key is this request's answer, not a clash.
    const twin = await replayOf(deps.sql, caller.userId, input.requestId, checked.fingerprint);
    if (twin) return twin;
    throw err;
  }
  const signs = signsByDefault(checked.scopes);
  if (signs && !deps.signingEncKey) {
    throw new DeveloperKeyError('Keys that place orders sign every request, and signing is not set up', 'identity.key_signing_unset');
  }
  await deps.mayMint?.(caller.userId, !input.factorProof ? 'none' : 'webauthn' in input.factorProof ? 'passkey' : 'other');
  try {
    return await guardedApiKeyAction(
      deps.gate,
      caller,
      input.factorProof,
      { action: 'create', scopes: checked.scopes },
      async (scope): Promise<ApiKeyCreateOutput> => {
        const tx = scope.tx;
        await tx`SELECT id FROM users WHERE id = ${caller.userId} FOR UPDATE`;
        // The same request id may have committed while this one waited for the lock: answer with that key.
        const seen = await tx`SELECT 1 FROM api_key_create_requests WHERE user_id = ${caller.userId} AND request_id = ${input.requestId}`;
        if (seen.length > 0) throw new SameRequestRace();
        await assertNameFree(tx, caller.userId, checked.name);
        await assertUnderCap(deps, caller.userId, tx);
        const minted = await scope.createApiKey({
          userId: caller.userId,
          name: checked.name,
          scopes: checked.scopes,
          grantorScopes: caller.scopes,
          grantorKid: caller.kid ?? null,
          ...(checked.expiresAt ? { expiresAt: checked.expiresAt } : {}),
          mode: 'live',
        });
        if (checked.ips.length > 0) await bindApiKeyIpAllowlist(tx, caller.userId, minted.id, checked.ips);
        let signingSecret: string | null = null;
        if (signs) {
          signingSecret = issueSigningSecret();
          await tx`
            UPDATE api_keys
            SET require_signature = true, request_signing_secret = ${sealSigningSecret(deps.signingEncKey ?? null, signingSecret)}
            WHERE id = ${minted.id} AND user_id = ${caller.userId}
          `;
        }
        const recorded = await tx<Array<{ key_id: string }>>`
          INSERT INTO api_key_create_requests (user_id, request_id, key_id, fingerprint)
          VALUES (${caller.userId}, ${input.requestId}, ${minted.id}, ${checked.fingerprint})
          ON CONFLICT (user_id, request_id) DO NOTHING
          RETURNING key_id
        `;
        // The same request id committed first from another call: undo this key and answer with that one.
        if (!recorded[0]) throw new SameRequestRace();
        const rows = await tx<KeyRow[]>`
          SELECT id, name, key_prefix, mode, scopes, ip_allowlist, require_signature, created_at, expires_at, last_used_at, revoked
          FROM api_keys WHERE id = ${minted.id}
        `;
        return { record: toRecord(rows[0]!), key: minted.key, signingSecret, replayed: false };
      },
    );
  } catch (err) {
    if (!(err instanceof SameRequestRace)) throw err;
    const raced = await replayOf(deps.sql, caller.userId, input.requestId, checked.fingerprint);
    if (!raced) throw new DeveloperKeyError('This request id was already used for a different key', 'identity.key_request_conflict');
    return raced;
  }
}

/**
 * The live service's rule for who may hold a key: an enrolled passkey that has passed an assertion
 * (`requireVerifiedPasskey`). A passkey not yet used still lets a passkey-confirmed create through, since that
 * step-up verifies it before the mint, and a create with no factor through to the step-up refusal. A code-confirmed
 * create is refused here, before the code is spent.
 */
export function passkeyMintRule(sql: Sql): NonNullable<DeveloperKeysDeps['mayMint']> {
  return async (userId, factor) => {
    const rows = await sql<Array<{ webauthn_creds: unknown }>>`SELECT webauthn_creds FROM users WHERE id = ${userId} LIMIT 1`;
    try {
      requireVerifiedPasskey(rows[0]?.webauthn_creds);
    } catch (err) {
      if (err instanceof MintApiKeyPasskeyError && err.code === 'auth.passkey_verify_unavailable' && factor !== 'other') return;
      throw err;
    }
  };
}

/** The account's keys, newest first, with the cap and how many keys count against it. Never a secret or a hash. */
export async function listDeveloperKeys(deps: DeveloperKeysDeps, userId: string, limit: number): Promise<ApiKeyList> {
  const rows = await deps.sql<KeyRow[]>`
    SELECT id, name, key_prefix, mode, scopes, ip_allowlist, require_signature, created_at, expires_at, last_used_at, revoked
    FROM api_keys WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT ${limit}
  `;
  return {
    keys: rows.map(toRecord),
    cap: { limit: await capFor(deps, userId, deps.sql), live: await liveKeyCount(deps.sql, userId) },
  };
}
