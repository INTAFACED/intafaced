/**
 * Named developer sandboxes and their keys (DV-sandbox-01, journey J-developer-02 #2 and #3).
 *
 * A sandbox is a named place for TEST work on one account. Every account may hold one; a second and later one needs
 * the owner's sandbox count cap for the account's verification level (`IDENTITY_SANDBOXES_MAX_BY_TIER`), and a blank
 * cap refuses `identity.sandbox_cap_unset`. The name, the cap and the request id are decided under the account row
 * lock, so two creates at once cannot both pass.
 *
 * A sandbox key is an API key made in the `sandbox` environment, which never changes (the table refuses any update of
 * it). It may hold the sandbox-safe scopes only (`SANDBOX_KEY_SCOPES`); any other scope refuses
 * `env.scope_not_sandboxable` before a factor is spent, and nothing is made. A key never holds more than its maker, in
 * the sandbox too: the pay scopes come from the merchant grant, which has no sandbox temporary grant
 * (`@intafaced/auth` merchant-pay-scope-grant), so a person without them is refused `auth.scope_not_held`. Every
 * other key rule holds as on a live key: a fresh second factor, the passkey mint rule, a name unique among the
 * account's keys, and the owner's key cap, which counts sandbox keys with live ones.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { isScope } from '@intafaced/auth';
import type { ApiKeyRecord } from '@intafaced/contracts/api-keys';
import {
  SANDBOX_NAME_MAX,
  isSandboxKeyScope,
  type SandboxCreateInput,
  type SandboxCreateOutput,
  type SandboxDetail,
  type SandboxKeyCreateInput,
  type SandboxKeyCreateOutput,
  type SandboxList,
  type SandboxRecord,
} from '@intafaced/contracts/developer-sandboxes';
import { transaction } from '@intafaced/db';
import type { KycTier, PayStepUpFactorProof } from './auth-service.js';
import { bindApiKeyIpAllowlist } from './auth-service-ip.js';
import { guardedApiKeyAction } from './api-key-fresh-factor.js';
import { checkCreate, DeveloperKeyError, toRecord, type DeveloperKeysDeps, type KeyRow } from './developer-keys.js';
import { linkSandboxKey } from './sandbox-key-link.js';

export type DeveloperSandboxRefusal =
  | 'identity.sandbox_name_invalid'
  | 'identity.sandbox_name_taken'
  | 'identity.sandbox_cap_unset'
  | 'identity.sandbox_cap_reached'
  | 'identity.sandbox_request_conflict'
  | 'identity.sandbox_not_found'
  | 'env.scope_not_sandboxable';

export class DeveloperSandboxError extends Error {
  constructor(
    message: string,
    readonly code: DeveloperSandboxRefusal,
  ) {
    super(message);
    this.name = 'DeveloperSandboxError';
  }
}

const TIERS: readonly KycTier[] = ['none', 'basic', 'full', 'institutional'];

/**
 * `IDENTITY_SANDBOXES_MAX_BY_TIER`: how many sandboxes an account may hold per verification level, `tier=count` pairs
 * joined by commas (`full=3`). Blank: null, and a second sandbox refuses `identity.sandbox_cap_unset`. A level left out
 * refuses the same way. A malformed value throws, so the service does not start on a cap it cannot read.
 */
export function parseSandboxCapByTier(raw: string | undefined): ReadonlyMap<KycTier, number> | null {
  if (raw === undefined || raw.trim() === '') return null;
  const caps = new Map<KycTier, number>();
  for (const part of raw.split(',')) {
    const match = /^\s*([a-z]+)\s*=\s*(\d{1,4})\s*$/.exec(part);
    const tier = match?.[1] as KycTier | undefined;
    if (!match || !tier || !TIERS.includes(tier) || caps.has(tier)) {
      throw new Error('IDENTITY_SANDBOXES_MAX_BY_TIER must be tier=count pairs (none, basic, full, institutional), each tier once');
    }
    caps.set(tier, Number(match[2]));
  }
  return caps;
}

/** `IDENTITY_SANDBOX_BASE_URL`: where the door serves sandbox keys. Blank: null, and the room says it is not set. */
export function parseSandboxBaseUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('IDENTITY_SANDBOX_BASE_URL must be an http(s) URL');
  return url.origin;
}

export type DeveloperSandboxesDeps = DeveloperKeysDeps & {
  sandboxCapByTier: ReadonlyMap<KycTier, number> | null;
  baseUrl: string | null;
};

type Caller = { userId: string; sid: string; kid?: string | undefined; sub_account?: string | undefined; scopes: readonly string[] };

const NAME = new RegExp(`^[^\\p{Cc}\\p{Cf}]{1,${SANDBOX_NAME_MAX}}$`, 'u');

type SandboxRow = { id: string; name: string; created_at: Date };
const toSandbox = (row: SandboxRow): SandboxRecord => ({ id: row.id, name: row.name, createdAt: row.created_at.toISOString() });

async function heldCount(sql: Sql, userId: string): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM developer_sandboxes WHERE user_id = ${userId}`;
  return rows[0]?.n ?? 0;
}

async function sandboxCapFor(deps: DeveloperSandboxesDeps, userId: string, sql: Sql): Promise<number | null> {
  if (!deps.sandboxCapByTier) return null;
  return deps.sandboxCapByTier.get(await deps.kycTier(userId, sql)) ?? null;
}

async function sandboxReplay(sql: Sql, userId: string, requestId: string, name: string): Promise<SandboxCreateOutput | null> {
  const rows = await sql<SandboxRow[]>`
    SELECT id, name, created_at FROM developer_sandboxes WHERE user_id = ${userId} AND request_id = ${requestId}`;
  const row = rows[0];
  if (!row) return null;
  if (row.name.toLowerCase() !== name.toLowerCase()) {
    throw new DeveloperSandboxError('This request id was already used for a different sandbox', 'identity.sandbox_request_conflict');
  }
  return { sandbox: toSandbox(row), replayed: true };
}

/** The first sandbox needs no cap; a second and later one needs the owner's cap for the account's level. A set cap of
 * 0 holds for the first one too. */
async function assertMayHoldAnother(deps: DeveloperSandboxesDeps, userId: string, sql: Sql): Promise<void> {
  const held = await heldCount(sql, userId);
  const cap = await sandboxCapFor(deps, userId, sql);
  if (held === 0 && cap === null) return;
  if (cap === null) {
    throw new DeveloperSandboxError('The number of sandboxes an account may hold is not set', 'identity.sandbox_cap_unset');
  }
  if (held >= cap) throw new DeveloperSandboxError('This account holds as many sandboxes as it may', 'identity.sandbox_cap_reached');
}

export async function createSandbox(deps: DeveloperSandboxesDeps, caller: Caller, input: SandboxCreateInput): Promise<SandboxCreateOutput> {
  const name = input.name.trim();
  if (!NAME.test(name)) {
    throw new DeveloperSandboxError(
      'Use a sandbox name of 1 to 40 characters, with no control characters',
      'identity.sandbox_name_invalid',
    );
  }
  const replay = await sandboxReplay(deps.sql, caller.userId, input.requestId, name);
  if (replay) return replay;
  return transaction(
    deps.sql,
    async (tx) => {
      await tx`SELECT id FROM users WHERE id = ${caller.userId} FOR UPDATE`;
      // The same request may have committed while this one waited for the lock: answer with that sandbox.
      const raced = await sandboxReplay(tx, caller.userId, input.requestId, name);
      if (raced) return raced;
      const taken = await tx`SELECT 1 FROM developer_sandboxes WHERE user_id = ${caller.userId} AND lower(name) = lower(${name})`;
      if (taken.length > 0) throw new DeveloperSandboxError('You already have a sandbox with this name', 'identity.sandbox_name_taken');
      await assertMayHoldAnother(deps, caller.userId, tx);
      const rows = await tx<SandboxRow[]>`
      INSERT INTO developer_sandboxes (user_id, name, request_id) VALUES (${caller.userId}, ${name}, ${input.requestId})
      RETURNING id, name, created_at`;
      return { sandbox: toSandbox(rows[0]!), replayed: false };
    },
    { isolation: 'read committed' },
  );
}

export async function listSandboxes(deps: DeveloperSandboxesDeps, userId: string): Promise<SandboxList> {
  const rows = await deps.sql<SandboxRow[]>`
    SELECT id, name, created_at FROM developer_sandboxes WHERE user_id = ${userId} ORDER BY created_at, id LIMIT 200`;
  return {
    sandboxes: rows.map(toSandbox),
    cap: { limit: await sandboxCapFor(deps, userId, deps.sql), held: rows.length },
    baseUrl: deps.baseUrl,
  };
}

async function ownSandbox(sql: Sql, userId: string, sandboxId: string): Promise<SandboxRow> {
  const rows = await sql<
    SandboxRow[]
  >`SELECT id, name, created_at FROM developer_sandboxes WHERE id = ${sandboxId} AND user_id = ${userId}`;
  if (!rows[0]) throw new DeveloperSandboxError('No such sandbox on this account', 'identity.sandbox_not_found');
  return rows[0];
}

export async function getSandbox(deps: DeveloperSandboxesDeps, userId: string, sandboxId: string): Promise<SandboxDetail> {
  const sandbox = await ownSandbox(deps.sql, userId, sandboxId);
  const keys = await deps.sql<KeyRow[]>`
    SELECT k.id, k.name, k.key_prefix, k.mode, k.scopes, k.ip_allowlist, k.require_signature, k.created_at, k.expires_at,
           k.last_used_at, k.revoked, k.revoked_at, k.revoked_cause, k.revoke_reason
    FROM developer_sandbox_keys s JOIN api_keys k ON k.id = s.api_key_id AND k.user_id = ${userId}
    WHERE s.sandbox_id = ${sandboxId}
    ORDER BY k.created_at DESC, k.id DESC LIMIT 200`;
  return { sandbox: toSandbox(sandbox), keys: keys.map(toRecord), baseUrl: deps.baseUrl };
}

/** Every scope asked for must be one a sandbox serves. Checked before anything is read or a factor is spent. */
export function assertSandboxable(scopes: readonly string[]): void {
  for (const scope of scopes) {
    if (!isScope(scope)) throw new DeveloperKeyError('A permission on this key does not exist', 'auth.scope_unknown');
    if (!isSandboxKeyScope(scope)) {
      throw new DeveloperSandboxError('A sandbox cannot serve this permission, so no key was made', 'env.scope_not_sandboxable');
    }
  }
}

async function keyReplay(sql: Sql, userId: string, requestId: string, fingerprint: string): Promise<KeyRow | null> {
  const rows = await sql<Array<KeyRow & { fingerprint: string }>>`
    SELECT r.fingerprint, k.id, k.name, k.key_prefix, k.mode, k.scopes, k.ip_allowlist, k.require_signature,
           k.created_at, k.expires_at, k.last_used_at, k.revoked, k.revoked_at, k.revoked_cause, k.revoke_reason
    FROM api_key_create_requests r JOIN api_keys k ON k.id = r.key_id AND k.user_id = r.user_id
    WHERE r.user_id = ${userId} AND r.request_id = ${requestId}`;
  const row = rows[0];
  if (!row) return null;
  if (row.fingerprint !== fingerprint) {
    throw new DeveloperKeyError('This request id was already used for a different key', 'identity.key_request_conflict');
  }
  return row;
}

async function assertKeyNameFree(sql: Sql, userId: string, name: string): Promise<void> {
  const taken = await sql`
    SELECT id FROM api_keys
    WHERE user_id = ${userId} AND revoked = false AND (expires_at IS NULL OR expires_at > now()) AND lower(name) = lower(${name})
    LIMIT 1`;
  if (taken[0]) throw new DeveloperKeyError('You already have a key with this name', 'identity.key_name_taken');
}

async function assertUnderKeyCap(deps: DeveloperSandboxesDeps, userId: string, sql: Sql): Promise<void> {
  const cap = deps.capByTier?.get(await deps.kycTier(userId, sql)) ?? null;
  if (cap === null) throw new DeveloperKeyError('The number of API keys an account may hold is not set', 'identity.key_cap_unset');
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM api_keys WHERE user_id = ${userId} AND revoked = false AND (expires_at IS NULL OR expires_at > now())`;
  if ((rows[0]?.n ?? 0) >= cap) throw new DeveloperKeyError('This account holds as many API keys as it may', 'identity.key_cap_reached');
}

class SameRequestRace extends Error {}

export async function createSandboxKey(
  deps: DeveloperSandboxesDeps,
  caller: Caller,
  input: SandboxKeyCreateInput & { factorProof?: PayStepUpFactorProof | undefined },
): Promise<SandboxKeyCreateOutput> {
  const now = deps.now?.() ?? new Date();
  assertSandboxable(input.scopes);
  // The key door's own shape rules (name, empty list, IPs, end date) and its maker rule: only scopes the sign-in holds.
  const { sandboxId, requestId, factorProof, ...asked } = input;
  const checked = checkCreate(asked, caller.scopes, now);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([sandboxId.toLowerCase(), checked.fingerprint]))
    .digest('hex');
  await ownSandbox(deps.sql, caller.userId, sandboxId);
  const answer = (row: KeyRow, key: string | null, replayed: boolean): SandboxKeyCreateOutput => ({
    record: toRecord(row),
    key,
    replayed,
    baseUrl: deps.baseUrl,
  });
  const replay = await keyReplay(deps.sql, caller.userId, requestId, fingerprint);
  if (replay) return answer(replay, null, true);
  try {
    await assertKeyNameFree(deps.sql, caller.userId, checked.name);
    await assertUnderKeyCap(deps, caller.userId, deps.sql);
  } catch (err) {
    // The twin of this request may have committed since the replay read: its key is this request's answer, not a clash.
    const twin = await keyReplay(deps.sql, caller.userId, requestId, fingerprint);
    if (twin) return answer(twin, null, true);
    throw err;
  }
  await deps.mayMint?.(caller.userId, !factorProof ? 'none' : 'webauthn' in factorProof ? 'passkey' : 'other');
  try {
    return await guardedApiKeyAction(deps.gate, caller, factorProof, { action: 'create', scopes: checked.scopes }, async (scope) => {
      const tx = scope.tx;
      await tx`SELECT id FROM users WHERE id = ${caller.userId} FOR UPDATE`;
      const seen = await tx`SELECT 1 FROM api_key_create_requests WHERE user_id = ${caller.userId} AND request_id = ${requestId}`;
      if (seen.length > 0) throw new SameRequestRace();
      await ownSandbox(tx, caller.userId, sandboxId);
      await assertKeyNameFree(tx, caller.userId, checked.name);
      await assertUnderKeyCap(deps, caller.userId, tx);
      const minted = await scope.createApiKey({
        userId: caller.userId,
        name: checked.name,
        scopes: checked.scopes,
        grantorScopes: caller.scopes,
        grantorKid: caller.kid ?? null,
        ...(checked.expiresAt ? { expiresAt: checked.expiresAt } : {}),
        mode: 'sandbox',
      });
      if (checked.ips.length > 0) await bindApiKeyIpAllowlist(tx, caller.userId, minted.id, checked.ips);
      const recorded = await tx`
        INSERT INTO api_key_create_requests (user_id, request_id, key_id, fingerprint)
        VALUES (${caller.userId}, ${requestId}, ${minted.id}, ${fingerprint})
        ON CONFLICT (user_id, request_id) DO NOTHING
        RETURNING key_id`;
      if (!recorded[0]) throw new SameRequestRace();
      await linkSandboxKey(tx, minted.id, sandboxId);
      const rows = await tx<KeyRow[]>`
        SELECT id, name, key_prefix, mode, scopes, ip_allowlist, require_signature, created_at, expires_at, last_used_at, revoked,
               revoked_at, revoked_cause, revoke_reason
        FROM api_keys WHERE id = ${minted.id}`;
      return answer(rows[0]!, minted.key, false);
    });
  } catch (err) {
    if (!(err instanceof SameRequestRace)) throw err;
    const raced = await keyReplay(deps.sql, caller.userId, requestId, fingerprint);
    if (!raced) throw new DeveloperKeyError('This request id was already used for a different key', 'identity.key_request_conflict');
    return answer(raced, null, true);
  }
}
