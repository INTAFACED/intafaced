import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { lockFounderControls } from './founder-control-lock.js';
import {
  accountControlInputSchema,
  accountControlLookupInputSchema,
  accountControlHistoryInputSchema,
  accountControlResultSchema,
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
  accountOperatorEntitlementSchema,
  type AccountOperatorEntitlement,
  type AccountControlInput,
  type AccountControlResult,
  type AccountControlState,
  type Context,
  type CurrentAuthorityInput,
  type CurrentAuthorityResult,
} from '@intafaced/contracts';

export class FounderControlError extends Error {
  constructor(
    readonly code: 'identity.controls_unconfigured' | 'identity.controls_unavailable' | 'operator.denied' | 'mfa.required',
    message: string,
  ) {
    super(message);
    this.name = 'FounderControlError';
  }
}

/** Deployment configuration is a pair of UUIDs, never handles or display names. */
export function parseFounderPair(first: unknown, second: unknown): readonly [string, string] | null {
  const a = z.string().trim().uuid().safeParse(first);
  const b = z.string().trim().uuid().safeParse(second);
  if (!a.success || !b.success || a.data.toLowerCase() === b.data.toLowerCase()) return null;
  return [a.data.toLowerCase(), b.data.toLowerCase()].sort() as [string, string];
}

type UserRow = {
  id: string;
  status: 'active' | 'frozen' | 'closed';
  identity_control_version: string;
  totp_enrolled_at: Date | null;
  totp_secret: string | null;
  webauthn_creds: unknown;
};
type SessionRow = { id: string; user_id: string; revoked: boolean; mfa: boolean; expires_at: Date };
type EntitlementRow = { user_id: string; enabled: boolean; version: string; changed_at: Date };
export type FounderEntitlement = AccountOperatorEntitlement;

export function hasVerifiedSecondFactor(user: Pick<UserRow, 'totp_enrolled_at' | 'totp_secret' | 'webauthn_creds'>): boolean {
  if (user.totp_enrolled_at instanceof Date && user.totp_secret) return true;
  return (
    Array.isArray(user.webauthn_creds) &&
    user.webauthn_creds.some((value: unknown) => {
      if (!value || typeof value !== 'object') return false;
      const credential = value as Record<string, unknown>;
      // Both existing registration writers store this shape only after verified
      // WebAuthn registration with user verification. First use may have counter 0.
      return (
        typeof credential.credentialId === 'string' &&
        credential.credentialId.length > 0 &&
        typeof credential.publicKey === 'string' &&
        credential.publicKey.length > 0 &&
        typeof credential.counter === 'number' &&
        Number.isSafeInteger(credential.counter) &&
        credential.counter >= 0 &&
        typeof credential.createdAt === 'string' &&
        Number.isFinite(Date.parse(credential.createdAt))
      );
    })
  );
}

export function founderActorRefusal(
  context: Context,
  pair: readonly string[] | null,
  user?: UserRow,
  session?: SessionRow,
  entitlement?: EntitlementRow,
  now = new Date(),
): 'operator.denied' | 'mfa.required' | null {
  const principal = context.principal;
  if (
    !pair ||
    !principal ||
    context.service !== null ||
    principal.kid ||
    principal.sub_account ||
    !pair.includes(principal.userId) ||
    principal.expiresAt.getTime() <= now.getTime()
  )
    return 'operator.denied';
  if (!principal.mfa) return 'mfa.required';
  if (
    !user ||
    user.id !== principal.userId ||
    user.status !== 'active' ||
    !hasVerifiedSecondFactor(user) ||
    !entitlement?.enabled ||
    entitlement.user_id !== principal.userId ||
    !session ||
    session.user_id !== principal.userId ||
    session.id !== principal.sid ||
    session.revoked ||
    session.expires_at.getTime() <= now.getTime()
  )
    return 'operator.denied';
  if (!session.mfa) return 'mfa.required';
  return null;
}

const version = z
  .string()
  .max(40)
  .regex(/^(?:0|[1-9]\d*)$/);
// PostgreSQL UUIDs have one canonical spelling; normalize validated local inputs
// before equality checks, persisted JSON and idempotency fingerprints.
const canonicalUuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const founderEntitlementChangeSchema = z
  .object({
    requestId: canonicalUuid,
    userId: canonicalUuid,
    action: z.enum(['revoke', 'restore']),
    reason: z.string().trim().min(3).max(500),
    expectedVersion: version,
  })
  .strict();
export type FounderEntitlementChange = z.infer<typeof founderEntitlementChangeSchema>;
export type EntitlementChangeResult = {
  outcome: 'changed' | 'noop' | 'conflict' | 'refused';
  auditId: string;
  entitlement: FounderEntitlement | null;
  code?: 'operator.denied' | 'mfa.required' | 'restriction.version_conflict' | 'request.conflict' | 'restore.not_permitted';
};

function fingerprint(actorId: string | null, input: unknown): string {
  return createHash('sha256').update(JSON.stringify({ actorId, input })).digest('hex');
}
function storageError(error: unknown): FounderControlError {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return code === '42P01' || code === '42703'
    ? new FounderControlError('identity.controls_unconfigured', 'Founder controls require their migration')
    : new FounderControlError('identity.controls_unavailable', 'Founder control storage is unavailable');
}

/** One implementation owns entitlement checks, transaction ordering and immutable history. */
export class FounderControls {
  private configured = false;
  constructor(
    private readonly sql: Sql,
    private readonly pair: readonly [string, string] | null,
  ) {}

  readiness() {
    return { configured: this.configured };
  }

  private async lock(tx: Sql): Promise<void> {
    // All founder commands share this order. Existing refresh locks session then
    // user, so we also lock affected sessions before sorted user rows.
    await lockFounderControls(tx);
  }

  async bootstrap(): Promise<boolean> {
    this.configured = false;
    const pair = this.pair;
    if (!pair) return false;
    try {
      this.configured = await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const [existing] = await tx<
            Array<{ founder_ids: string[] }>
          >`SELECT founder_ids FROM founder_control_configuration WHERE singleton = true`;
          if (existing) return JSON.stringify(existing.founder_ids) === JSON.stringify(pair);
          const users = await tx<
            UserRow[]
          >`SELECT id, status, identity_control_version::text, totp_enrolled_at, totp_secret, webauthn_creds FROM users WHERE id IN ${tx(pair)} ORDER BY id FOR UPDATE`;
          if (users.length !== 2 || users.some((user) => user.status !== 'active' || !hasVerifiedSecondFactor(user))) return false;
          await tx`INSERT INTO founder_control_configuration (founder_ids) VALUES (${tx.array([...pair])}::uuid[])`;
          for (const user of users) {
            await tx`INSERT INTO founder_operator_entitlements (user_id, enabled) VALUES (${user.id}, true) ON CONFLICT (user_id) DO NOTHING`;
            const result = { userId: user.id, status: 'enabled', reason: 'Configured existing MFA identity bootstrap' };
            await this.audit(tx, randomUUID(), null, 'bootstrap', fingerprint(null, result), result);
          }
          return true;
        },
        { isolation: 'read committed' },
      );
      return this.configured;
    } catch (error) {
      const shaped = storageError(error);
      if (shaped.code === 'identity.controls_unconfigured') return false;
      throw shaped;
    }
  }

  private async actor(
    tx: Sql,
    context: Context,
    targetId?: string,
  ): Promise<{ refusal: 'operator.denied' | 'mfa.required' | null; users: UserRow[] }> {
    const principal = context.principal;
    if (
      !this.configured ||
      !this.pair ||
      !principal ||
      context.service !== null ||
      principal.kid ||
      principal.sub_account ||
      !this.pair.includes(principal.userId) ||
      principal.expiresAt.getTime() <= Date.now()
    )
      return { refusal: 'operator.denied', users: [] };
    if (!principal.mfa) return { refusal: 'mfa.required', users: [] };
    const ids = [...new Set([principal.userId, ...(targetId ? [targetId] : [])])].sort();
    const sessions = await tx<
      SessionRow[]
    >`SELECT id, user_id, revoked, mfa, expires_at FROM sessions WHERE user_id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
    const users = await tx<
      UserRow[]
    >`SELECT id, status, identity_control_version::text, totp_enrolled_at, totp_secret, webauthn_creds FROM users WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
    const [entitlement] = await tx<
      EntitlementRow[]
    >`SELECT user_id, enabled, version::text, changed_at FROM founder_operator_entitlements WHERE user_id = ${principal.userId} FOR UPDATE`;
    return {
      refusal: founderActorRefusal(
        context,
        this.pair,
        users.find((user) => user.id === principal.userId),
        sessions.find((row) => row.id === principal.sid),
        entitlement,
      ),
      users,
    };
  }

  private async audit(
    tx: Sql,
    requestId: string,
    actorId: string | null,
    kind: 'identity' | 'entitlement' | 'bootstrap',
    hash: string,
    result: unknown,
    auditId = randomUUID(),
    detail: unknown = {},
  ): Promise<string> {
    await tx`INSERT INTO founder_control_audit (audit_id, request_id, actor_id, kind, fingerprint, result, detail) VALUES (${auditId}, ${requestId}, ${actorId}, ${kind}, ${hash}, ${tx.json(result as never)}, ${tx.json(detail as never)})`;
    return auditId;
  }

  private async replay(tx: Sql, requestId: string, hash: string): Promise<{ conflict: boolean; result: unknown } | null> {
    const [row] = await tx<
      Array<{ fingerprint: string; result: unknown }>
    >`SELECT r.fingerprint, a.result FROM founder_control_requests r JOIN founder_control_audit a ON a.audit_id = r.audit_id WHERE r.request_id = ${requestId}`;
    return row ? { conflict: row.fingerprint !== hash, result: row.result } : null;
  }

  async change(context: Context, raw: AccountControlInput): Promise<AccountControlResult> {
    const input = accountControlInputSchema.parse(raw);
    if (input.target.area !== 'identity') throw new FounderControlError('operator.denied', 'Identity controls cannot alter another module');
    input.requestId = input.requestId.toLowerCase();
    input.target.userId = input.target.userId.toLowerCase();
    const targetId = input.target.userId;
    const actorId = context.principal?.userId ?? null;
    const hash = fingerprint(actorId, input);
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context, targetId);
          const [clock] = await tx<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
          const auditId = randomUUID();
          const common = {
            auditId,
            requestId: input.requestId,
            target: input.target,
            action: input.action,
            reason: input.reason,
            occurredAt: clock!.at.toISOString(),
            actorUserId: actorId,
          };
          const refused = (
            code: 'operator.denied' | 'mfa.required' | 'target.not_found' | 'restore.not_permitted' | 'request.conflict',
            current: AccountControlState | null = null,
          ) => accountControlResultSchema.parse({ ...common, outcome: 'refused', changed: false, code, current });
          let result: AccountControlResult;
          if (actor.refusal) {
            result = refused(actor.refusal);
            await this.audit(tx, input.requestId, actorId, 'identity', hash, result, auditId);
            return result;
          }
          // Re-authenticate before looking up any original result, including retries.
          const previous = await this.replay(tx, input.requestId, hash);
          if (previous && !previous.conflict) return accountControlResultSchema.parse(previous.result);
          if (previous) {
            result = refused('request.conflict');
          } else {
            const user = actor.users.find((row) => row.id === targetId);
            if (!user) result = refused('target.not_found');
            else {
              const before: AccountControlState = {
                target: input.target,
                version: user.identity_control_version,
                restricted: user.status !== 'active',
              };
              if (before.version !== input.expectedVersion)
                result = accountControlResultSchema.parse({
                  ...common,
                  outcome: 'conflict',
                  changed: false,
                  code: 'restriction.version_conflict',
                  current: before,
                });
              else if (input.action === 'restore' && user.status === 'closed') result = refused('restore.not_permitted', before);
              else if (before.restricted === (input.action === 'restrict'))
                result = accountControlResultSchema.parse({ ...common, outcome: 'noop', changed: false, before, after: before });
              else {
                await tx`UPDATE users SET status = ${input.action === 'restrict' ? 'frozen' : 'active'}, identity_control_version = identity_control_version + 1, updated_at = now() WHERE id = ${targetId}`;
                if (input.action === 'restrict') {
                  await tx`UPDATE sessions SET revoked = true WHERE user_id = ${targetId} AND revoked = false`;
                  await tx`UPDATE api_keys SET revoked = true WHERE user_id = ${targetId} AND revoked = false`;
                  await tx`UPDATE sub_accounts SET revoked = true WHERE parent_user_id = ${targetId} AND revoked = false`;
                  await tx`UPDATE navigator_session_projections SET status = 'closed', published_at = now() WHERE user_id = ${targetId} AND status = 'open'`;
                }
                result = accountControlResultSchema.parse({
                  ...common,
                  outcome: 'changed',
                  changed: true,
                  before,
                  after: { ...before, version: (BigInt(before.version) + 1n).toString(), restricted: input.action === 'restrict' },
                });
              }
            }
          }
          await this.audit(tx, input.requestId, actorId, 'identity', hash, result, auditId);
          if (!previous)
            await tx`INSERT INTO founder_control_requests (request_id, actor_id, fingerprint, audit_id) VALUES (${input.requestId}, ${actorId!}, ${hash}, ${auditId})`;
          return result;
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  async entitlement(userId: string): Promise<FounderEntitlement> {
    userId = canonicalUuid.parse(userId);
    if (!this.configured || !this.pair) return { userId, status: 'unconfigured' };
    if (!this.pair.includes(userId)) return { userId, status: 'not_operator' };
    try {
      const [row] = await this.sql<
        EntitlementRow[]
      >`SELECT user_id, enabled, version::text, changed_at FROM founder_operator_entitlements WHERE user_id = ${userId}`;
      return row
        ? { userId, status: row.enabled ? 'enabled' : 'revoked', version: row.version, changedAt: row.changed_at.toISOString() }
        : { userId, status: 'unconfigured' };
    } catch (error) {
      if (storageError(error).code === 'identity.controls_unconfigured') return { userId, status: 'unconfigured' };
      throw storageError(error);
    }
  }

  /** A delegated read validates the original signed user, not body-supplied MFA. */
  async operatorEntitlement(context: Context, userId: string): Promise<AccountOperatorEntitlement> {
    userId = canonicalUuid.parse(userId);
    if (!context.service || !context.principal || context.principal.userId !== userId) return { userId, status: 'not_operator' };
    return this.checkedOperator(context, userId);
  }

  async operatorStatus(context: Context): Promise<AccountOperatorEntitlement> {
    if (!context.principal) throw new FounderControlError('operator.denied', 'Interactive authentication is required');
    if (context.service !== null) return { userId: context.principal.userId, status: 'not_operator' };
    return this.checkedOperator(context, context.principal.userId);
  }

  private async checkedOperator(context: Context, userId: string): Promise<AccountOperatorEntitlement> {
    if (!this.configured) return { userId, status: 'unconfigured' };
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          // Only delegated reads accept a service with a separately verified user
          // principal. Account-change commands never accept service authority.
          const actor = await this.actor(tx, { ...context, service: null });
          if (actor.refusal) {
            const [row] = await tx<
              EntitlementRow[]
            >`SELECT user_id, enabled, version::text, changed_at FROM founder_operator_entitlements WHERE user_id = ${userId}`;
            return row && !row.enabled
              ? accountOperatorEntitlementSchema.parse({
                  userId,
                  status: 'revoked',
                  version: row.version,
                  changedAt: row.changed_at.toISOString(),
                })
              : { userId, status: 'not_operator' as const };
          }
          const [row] = await tx<
            EntitlementRow[]
          >`SELECT user_id, enabled, version::text, changed_at FROM founder_operator_entitlements WHERE user_id = ${userId}`;
          return accountOperatorEntitlementSchema.parse({
            userId,
            status: 'enabled',
            version: row!.version,
            changedAt: row!.changed_at.toISOString(),
          });
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (storageError(error).code === 'identity.controls_unconfigured') return { userId, status: 'unconfigured' };
      throw storageError(error);
    }
  }

  async getState(context: Context, raw: z.infer<typeof accountControlLookupInputSchema>): Promise<AccountControlState | null> {
    const input = accountControlLookupInputSchema.parse(raw);
    if (input.target.area !== 'identity') throw new FounderControlError('operator.denied', 'Identity target required');
    input.target.userId = input.target.userId.toLowerCase();
    const userId = input.target.userId;
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context);
          if (actor.refusal) throw new FounderControlError(actor.refusal, 'Live founder authority is required');
          const [row] = await tx<
            Array<{ status: string; version: string }>
          >`SELECT status, identity_control_version::text AS version FROM users WHERE id = ${userId}`;
          return row ? { target: input.target, version: row.version, restricted: row.status !== 'active' } : null;
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  async history(context: Context, raw: z.infer<typeof accountControlHistoryInputSchema>): Promise<AccountControlResult[]> {
    const input = accountControlHistoryInputSchema.parse(raw);
    if (input.target.area !== 'identity') throw new FounderControlError('operator.denied', 'Identity target required');
    input.target.userId = input.target.userId.toLowerCase();
    const userId = input.target.userId;
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context);
          if (actor.refusal) throw new FounderControlError(actor.refusal, 'Live founder authority is required');
          const rows = await tx<
            Array<{ result: unknown }>
          >`SELECT result FROM founder_control_audit WHERE kind = 'identity' AND result->'target'->>'userId' = ${userId} ORDER BY created_at DESC, audit_id DESC LIMIT ${input.limit}`;
          return rows.map((row) => accountControlResultSchema.parse(row.result));
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  async changeEntitlement(context: Context, raw: FounderEntitlementChange): Promise<EntitlementChangeResult> {
    const input = founderEntitlementChangeSchema.parse(raw);
    const actorId = context.principal?.userId ?? null;
    const hash = fingerprint(actorId, { kind: 'entitlement', ...input });
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context, input.userId);
          const auditId = randomUUID();
          let result: EntitlementChangeResult;
          let previous: Awaited<ReturnType<FounderControls['replay']>> = null;
          if (actor.refusal) result = { outcome: 'refused', auditId, entitlement: null, code: actor.refusal };
          else {
            previous = await this.replay(tx, input.requestId, hash);
            if (previous && !previous.conflict) return previous.result as EntitlementChangeResult;
            const [row] = await tx<
              EntitlementRow[]
            >`SELECT user_id, enabled, version::text, changed_at FROM founder_operator_entitlements WHERE user_id = ${input.userId} FOR UPDATE`;
            const current: FounderEntitlement | null = row
              ? {
                  userId: row.user_id,
                  status: row.enabled ? 'enabled' : 'revoked',
                  version: row.version,
                  changedAt: row.changed_at.toISOString(),
                }
              : null;
            if (previous) result = { outcome: 'refused', auditId, entitlement: null, code: 'request.conflict' };
            else if (!this.pair?.includes(input.userId) || !row)
              result = { outcome: 'refused', auditId, entitlement: null, code: 'operator.denied' };
            else if (row.version !== input.expectedVersion)
              result = { outcome: 'conflict', auditId, entitlement: current, code: 'restriction.version_conflict' };
            else if (
              input.action === 'restore' &&
              !actor.users.some((user) => user.id === input.userId && user.status === 'active' && hasVerifiedSecondFactor(user))
            )
              result = { outcome: 'refused', auditId, entitlement: current, code: 'restore.not_permitted' };
            else if (row.enabled === (input.action === 'restore')) result = { outcome: 'noop', auditId, entitlement: current };
            else {
              const [updated] = await tx<
                EntitlementRow[]
              >`UPDATE founder_operator_entitlements SET enabled = ${input.action === 'restore'}, version = version + 1, changed_at = clock_timestamp() WHERE user_id = ${input.userId} RETURNING user_id, enabled, version::text, changed_at`;
              result = {
                outcome: 'changed',
                auditId,
                entitlement: {
                  userId: input.userId,
                  status: updated!.enabled ? 'enabled' : 'revoked',
                  version: updated!.version,
                  changedAt: updated!.changed_at.toISOString(),
                },
              };
            }
          }
          await this.audit(tx, input.requestId, actorId, 'entitlement', hash, result, auditId, { input, actorUserId: actorId });
          if (!actor.refusal && !previous)
            await tx`INSERT INTO founder_control_requests (request_id, actor_id, fingerprint, audit_id) VALUES (${input.requestId}, ${actorId!}, ${hash}, ${auditId})`;
          return result;
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  async currentAuthority(raw: CurrentAuthorityInput): Promise<CurrentAuthorityResult> {
    const input = currentAuthorityInputSchema.parse(raw);
    input.userId = input.userId.toLowerCase();
    if (input.credential.kind === 'session') input.credential.sessionId = input.credential.sessionId.toLowerCase();
    else input.credential.apiKeyId = input.credential.apiKeyId.toLowerCase();
    if (input.subAccountId) input.subAccountId = input.subAccountId.toLowerCase();
    try {
      return await transaction(this.sql, async (tx) => {
        const [clock] = await tx<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
        const checkedAt = clock!.at;
        const common = { subject: input, checkedAt: checkedAt.toISOString() };
        const denied = (
          code:
            | 'auth.account_frozen'
            | 'auth.credential_denied'
            | 'auth.credential_revoked'
            | 'auth.credential_expired'
            | 'auth.sub_account_denied',
        ) => currentAuthorityResultSchema.parse({ ...common, status: 'denied', code });
        const [user] = await tx<
          Array<{ id: string; status: string; identity_control_version: string }>
        >`SELECT id, status, identity_control_version::text FROM users WHERE id = ${input.userId}`;
        if (!user || user.status !== 'active') return denied('auth.account_frozen');
        const ref = input.credential;
        const rows =
          ref.kind === 'session'
            ? await tx<SessionRow[]>`SELECT id, user_id, revoked, mfa, expires_at FROM sessions WHERE id = ${ref.sessionId}`
            : await tx<
                Array<{ id: string; user_id: string; revoked: boolean; expires_at: Date | null }>
              >`SELECT id, user_id, revoked, expires_at FROM api_keys WHERE id = ${ref.apiKeyId}`;
        const credential = rows[0];
        if (!credential || credential.user_id !== input.userId) return denied('auth.credential_denied');
        if (credential.revoked) return denied('auth.credential_revoked');
        if (credential.expires_at && credential.expires_at <= checkedAt) return denied('auth.credential_expired');
        let subAccount: { id: string; parentUserId: string; revoked: boolean } | null = null;
        if (input.subAccountId) {
          const [sub] = await tx<
            Array<{ id: string; parent_user_id: string; revoked: boolean }>
          >`SELECT id, parent_user_id, revoked FROM sub_accounts WHERE id = ${input.subAccountId}`;
          if (!sub || sub.parent_user_id !== input.userId || sub.revoked) return denied('auth.sub_account_denied');
          subAccount = { id: sub.id, parentUserId: sub.parent_user_id, revoked: false };
        }
        const [kyc] = await tx<
          Array<{ tier: 'none' | 'basic' | 'full' | 'institutional' }>
        >`SELECT tier FROM kyc_records WHERE user_id = ${input.userId} AND status = 'approved' AND (expires_at IS NULL OR expires_at > ${checkedAt}) ORDER BY CASE tier WHEN 'institutional' THEN 3 WHEN 'full' THEN 2 WHEN 'basic' THEN 1 ELSE 0 END DESC LIMIT 1`;
        return currentAuthorityResultSchema.parse({
          ...common,
          status: 'eligible',
          account: { userId: input.userId, status: 'active', kycTier: kyc?.tier ?? 'none' },
          credential: { kind: ref.kind, ownership: { id: credential.id, userId: credential.user_id, revoked: false } },
          subAccount,
          version: user.identity_control_version,
          leaseExpiresAt: new Date(Math.min(checkedAt.getTime() + 5000, credential.expires_at?.getTime() ?? Infinity)).toISOString(),
        });
      });
    } catch {
      return currentAuthorityResultSchema.parse({
        subject: input,
        checkedAt: new Date().toISOString(),
        status: 'unavailable',
        code: 'authority.unavailable',
      });
    }
  }
}
