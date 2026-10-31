import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import {
  IDENTITY_ARCHIVE_ACTION_TYPE,
  IDENTITY_CLOSE_ACTION_TYPE,
  IDENTITY_REOPEN_ACTION_TYPE,
  IDENTITY_TIER_MOVE_ACTION_TYPE,
  IDENTITY_UNFREEZE_ACTION_TYPE,
  TRADE_OPS_OPERATOR_PERMISSION,
  TRADING_RESTRICT_ACTION_TYPE,
  TRADING_RESTRICT_TARGET_SERVICE,
} from '../auth/action-approval-audience.js';
import { identityActionPayloadHash } from '../auth/privileged-dual-control.js';
import { sqlCasConsume, sqlGetApprovalForUpdate, type StoredApproval } from '../auth/action-approval-store.js';
import { lockFounderControls } from './founder-control-lock.js';
import type { KycRejectReasons } from '../kyc/cases.js';
import { blankTierTerms } from './account-tiers.js';
import { assertRestrictedListReader, listRestrictedAccounts, type RestrictedAccountPage } from './restricted-accounts.js';
import {
  identityAccountControlInputSchema,
  accountControlLookupInputSchema,
  accountControlHistoryInputSchema,
  accountControlResultSchema,
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
  accountOperatorEntitlementSchema,
  accountClosureInputSchema,
  accountClosureLookupInputSchema,
  accountClosureHistoryInputSchema,
  accountClosureResultSchema,
  accountArchiveInputSchema,
  accountArchiveLookupInputSchema,
  accountArchiveHistoryInputSchema,
  accountArchiveResultSchema,
  accountArchiveProposalsSchema,
  type AccountArchiveInput,
  type AccountArchiveProposals,
  type AccountArchiveReasonCode,
  type AccountArchiveResult,
  type AccountArchiveState,
  accountTierMoveInputSchema,
  accountTierLookupInputSchema,
  accountTierHistoryInputSchema,
  accountTierResultSchema,
  type AccountTier,
  type AccountTierList,
  type AccountTierMoveInput,
  type AccountTierResult,
  type AccountTierState,
  type AccountClosureInput,
  type AccountClosureResult,
  type AccountClosureState,
  type AccountCloseReasonCode,
  type AccountOperatorEntitlement,
  type IdentityAccountControlInput,
  type AccountControlResult,
  type AccountControlState,
  type Context,
  type CurrentAuthorityInput,
  type CurrentAuthorityResult,
  type ServiceOperatorEntitlementInput,
} from '@intafaced/contracts';

export class FounderControlError extends Error {
  constructor(
    readonly code:
      | 'identity.controls_unconfigured'
      | 'identity.controls_unavailable'
      | 'identity.details_unconfigured'
      | 'identity.details_unreadable'
      | 'operator.denied'
      | 'mfa.required',
    message: string,
  ) {
    super(message);
    this.name = 'FounderControlError';
  }
}

/** Deployment configuration is a pair of UUIDs, never handles or display names. */
export function parseFounderPair(first: unknown, second: unknown): readonly [string, string] | null {
  const a = z.string().trim().guid().safeParse(first);
  const b = z.string().trim().guid().safeParse(second);
  if (!a.success || !b.success || a.data.toLowerCase() === b.data.toLowerCase()) return null;
  return [a.data.toLowerCase(), b.data.toLowerCase()].sort() as [string, string];
}

export type UserRow = {
  id: string;
  status: 'active' | 'frozen' | 'closed';
  identity_control_version: string;
  archived_at: Date | null;
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

/** Services that gate an operator action on this read. A new reader is a reviewed change here, not a setting. */
export const SERVICE_OPERATOR_READERS: readonly string[] = ['svc-trade', 'svc-pay', 'svc-ops'];

/** The checks `founderActorRefusal` makes, minus the ones that need a forwarded principal (the caller made those). */
function serviceOperatorLive(
  userId: string,
  user?: UserRow,
  session?: SessionRow,
  entitlement?: EntitlementRow,
  now = new Date(),
): boolean {
  return (
    !!user &&
    user.id === userId &&
    user.status === 'active' &&
    hasVerifiedSecondFactor(user) &&
    !!entitlement?.enabled &&
    entitlement.user_id === userId &&
    !!session &&
    session.user_id === userId &&
    !session.revoked &&
    session.mfa &&
    session.expires_at.getTime() > now.getTime()
  );
}

const version = z
  .string()
  .max(40)
  .regex(/^(?:0|[1-9]\d*)$/);
// PostgreSQL UUIDs have one canonical spelling; normalize validated local inputs
// before equality checks, persisted JSON and idempotency fingerprints.
const canonicalUuid = z
  .string()
  .guid()
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

function fingerprint(actorId: string | null, input: IdentityAccountControlInput): string;
function fingerprint(actorId: string | null, input: unknown): string;
function fingerprint(actorId: string | null, input: unknown): string {
  return createHash('sha256').update(JSON.stringify({ actorId, input })).digest('hex');
}
function storageError(error: unknown): FounderControlError {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return code === '42P01' || code === '42703'
    ? new FounderControlError('identity.controls_unconfigured', 'Founder controls require their migration')
    : new FounderControlError('identity.controls_unavailable', 'Founder control storage is unavailable');
}

/** Canonical payload hash for `trading.restrict`. Same function the trade desk uses (`founderChangeHash`). */
export function tradingRestrictPayloadHash(input: {
  readonly userId: string;
  readonly action: 'restrict' | 'restore';
  readonly reason: string;
  readonly expectedVersion: string;
  /** The owner-listed reason code, when staff gave one; bound only when present, so a change without one hashes as before. */
  readonly reasonCode?: string;
}): string {
  return founderChangeHash(
    {
      area: 'trading',
      userId: input.userId.toLowerCase(),
      action: input.action,
      reason: input.reason.trim(),
      ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
    },
    input.expectedVersion,
  );
}

/**
 * Canonical payload hash for `identity.account_unfreeze`: the account and the reason the approver read
 * (`identityActionPayloadHash`, `{ targetId, reason }`). The version is bound on the approval row, not in the hash.
 */
export function identityUnfreezePayloadHash(input: { readonly userId: string; readonly reason: string }): string {
  return identityActionPayloadHash(input.userId.toLowerCase(), { reason: input.reason.trim() });
}

/**
 * Canonical payload hash for `identity.account_tier_move`: the account, the tier it moves onto and the reason the approver
 * read. The version is bound on the approval row, not in the hash.
 */
export function identityTierPayloadHash(input: { readonly userId: string; readonly tierId: string; readonly reason: string }): string {
  return identityActionPayloadHash(input.userId.toLowerCase(), { action: 'tier_move', tierId: input.tierId, reason: input.reason.trim() });
}

/**
 * Canonical payload hash for `identity.account_close` and `identity.account_reopen`: the account, the action, the reason
 * code (close only) and the reason the approver read. The version is bound on the approval row, not in the hash.
 */
export function identityClosurePayloadHash(input: {
  readonly userId: string;
  readonly action: 'close' | 'reopen';
  readonly reasonCode?: AccountCloseReasonCode;
  readonly reason: string;
}): string {
  return identityActionPayloadHash(input.userId.toLowerCase(), {
    action: input.action,
    ...(input.action === 'close' ? { reasonCode: input.reasonCode ?? '' } : {}),
    reason: input.reason.trim(),
  });
}

/**
 * Canonical payload hash for `identity.account_archive`: the account, the reason code and the reason the approver read.
 * The version is bound on the approval row, not in the hash.
 */
export function identityArchivePayloadHash(input: {
  readonly userId: string;
  readonly reasonCode: AccountArchiveReasonCode;
  readonly reason: string;
}): string {
  return identityActionPayloadHash(input.userId.toLowerCase(), {
    action: 'archive',
    reasonCode: input.reasonCode,
    reason: input.reason.trim(),
  });
}

/** The closure checks a close runs first (svc-bank, svc-trade, svc-p2p): open products and balances block it. */
export type StaffClosureChecks = (input: {
  readonly userId: string;
  readonly subAccountIds: readonly string[];
}) => Promise<{ readonly ok: true; readonly blockers: readonly { code: string; count: number }[] } | { readonly ok: false }>;

type ClosureRefusal = Extract<AccountClosureResult, { outcome: 'refused' }>['code'];

type UnfreezeApproval =
  | { readonly approverId: string; readonly refusal: null }
  | { readonly approverId?: undefined; readonly refusal: 'restriction_approval_mismatch' | 'restriction_approval_consumed' };

/** What a stored identity approval must be bound to before it is spent. */
export interface IdentityApprovalWant {
  readonly approvalId: string;
  readonly actionType: string;
  readonly payloadHash: string;
  readonly targetId: string;
  readonly expectedVersion: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly now: Date;
}

export class FounderControls {
  private configured = false;
  constructor(
    private readonly sql: Sql,
    private readonly pair: readonly [string, string] | null,
    private readonly options: {
      readonly tradingRestrictRequiresApproval?: boolean;
      /** The owner's trading restriction reason list (`IDENTITY_TRADING_RESTRICTION_REASONS`); empty when unset. */
      readonly tradingRestrictionReasons?: KycRejectReasons;
    } = {},
  ) {}

  readiness() {
    return { configured: this.configured };
  }

  private async lock(tx: Sql): Promise<void> {
    // All founder commands share this order. Existing refresh locks session then
    // user, so we also lock affected sessions before sorted user rows.
    await lockFounderControls(tx);
  }

  private closureChecks: StaffClosureChecks | null = null;

  /** Wired after the closure clients exist. Unset, every staff close refuses `identity.close_check_unavailable`. */
  useClosureChecks(checks: StaffClosureChecks): void {
    this.closureChecks = checks;
  }

  private accountTiers: readonly AccountTier[] | undefined;

  private dormancyDays: number | null = null;

  /** The `IDENTITY_DORMANCY_DAYS` owner setting, parsed. Unset, no customer is proposed for archive and the console says so. */
  useDormancyDays(days: number | null): void {
    this.dormancyDays = days;
  }

  /** The `IDENTITY_ACCOUNT_TIERS` owner setting, parsed. Unset, the tier list says so and every tier move refuses. */
  useAccountTiers(tiers: readonly AccountTier[] | undefined): void {
    this.accountTiers = tiers;
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

  /**
   * One step of a founder door kept in its own file (customer details): the founder controls' lock, then the live-founder
   * check of `context`, with the target's row locked too, in one read-committed transaction. `fn` decides what a refusal
   * means; storage errors come back as typed founder control errors.
   */
  async founderStep<T>(
    context: Context,
    targetId: string,
    fn: (
      tx: Sql,
      founder: {
        readonly refusal: 'operator.denied' | 'mfa.required' | null;
        readonly actorId: string | null;
        readonly target: UserRow | undefined;
        readonly isFounderRecord: boolean;
      },
    ) => Promise<T>,
  ): Promise<T> {
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context, targetId);
          return fn(tx, {
            refusal: actor.refusal,
            actorId: context.principal?.userId.toLowerCase() ?? null,
            target: actor.users.find((row) => row.id === targetId),
            isFounderRecord: this.pair?.includes(targetId) ?? false,
          });
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  /**
   * Spends a founder-level identity approval for a desk outside this class (the limit overrides), on that desk's
   * transaction: bound to the action, account, payload and version, given by a different founder who is still a live
   * founder now, and consumed once.
   */
  async spendFounderApproval(
    tx: Sql,
    want: IdentityApprovalWant,
  ): Promise<{ readonly approverId: string; readonly refusal: null } | { readonly refusal: 'mismatch' | 'consumed' }> {
    const bound = await this.consumeIdentityApproval(tx, want, false);
    if (bound.refusal) return bound;
    if (!(await this.isLiveFounder(bound.approverId, tx))) return { refusal: 'mismatch' };
    return this.consumeIdentityApproval(tx, want);
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
    >`SELECT id, status, identity_control_version::text, archived_at, totp_enrolled_at, totp_secret, webauthn_creds FROM users WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
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
    kind: 'identity' | 'entitlement' | 'bootstrap' | 'closure' | 'tier' | 'archive',
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

  async change(context: Context, raw: IdentityAccountControlInput): Promise<AccountControlResult> {
    const input = identityAccountControlInputSchema.parse(raw);
    input.requestId = input.requestId.toLowerCase();
    if (input.target.area !== 'merchant') input.target.userId = input.target.userId.toLowerCase();
    if (input.target.area === 'trading') {
      if (this.options.tradingRestrictRequiresApproval !== true) {
        throw new FounderControlError('operator.denied', 'Identity controls cannot alter another module');
      }
      return this.changeTrading(context, input);
    }
    if (input.target.area !== 'identity') throw new FounderControlError('operator.denied', 'Identity controls cannot alter another module');
    if (input.reasonCode !== undefined) throw new FounderControlError('operator.denied', 'A reason code is only for a trading restriction');
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
            code:
              | 'operator.denied'
              | 'mfa.required'
              | 'target.not_found'
              | 'restore.not_permitted'
              | 'request.conflict'
              | 'restriction_no_four_eyes'
              | 'restriction_approval_mismatch'
              | 'restriction_approval_consumed'
              | 'identity.account_archived',
            current: AccountControlState | null = null,
          ) => accountControlResultSchema.parse({ ...common, outcome: 'refused', changed: false, code, current });
          let approverId: string | null = null;
          let unfreeze: UnfreezeApproval | undefined;
          let result: AccountControlResult;
          if (actor.refusal) {
            result = refused(actor.refusal);
            await this.audit(tx, input.requestId, actorId, 'identity', hash, result, auditId, { fourEyes: false });
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
              // An archived record is read-only: no freeze, no unfreeze (J-ops-console-04 #10).
              if (user.archived_at) result = refused('identity.account_archived', before);
              else if (before.version !== input.expectedVersion)
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
              else if (input.action === 'restore' && !input.approvalId) result = refused('restriction_no_four_eyes', before);
              else if (
                input.action === 'restore' &&
                (unfreeze = await this.consumeUnfreezeApproval(tx, input, targetId, actorId!, clock!.at)).refusal
              )
                result = refused(unfreeze.refusal, before);
              else {
                if (unfreeze?.approverId) approverId = unfreeze.approverId;
                await tx`UPDATE users SET status = ${input.action === 'restrict' ? 'frozen' : 'active'}, identity_control_version = identity_control_version + 1, updated_at = now() WHERE id = ${targetId}`;
                if (input.action === 'restrict') {
                  await tx`UPDATE sessions SET revoked = true WHERE user_id = ${targetId} AND revoked = false`;
                  await tx`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'account_freeze' WHERE user_id = ${targetId} AND revoked = false`;
                  await tx`UPDATE sub_accounts SET revoked = true WHERE parent_user_id = ${targetId} AND revoked = false`;
                  await tx`UPDATE navigator_session_projections SET status = 'closed', published_at = now() WHERE user_id = ${targetId} AND status = 'open'`;
                }
                result = accountControlResultSchema.parse({
                  ...common,
                  outcome: 'changed',
                  changed: true,
                  before,
                  after: { ...before, version: (BigInt(before.version) + 1n).toString(), restricted: input.action === 'restrict' },
                  ...(approverId ? { approverUserId: approverId } : {}),
                });
              }
            }
          }
          // An approval is named in the audit only when it was looked at (a restore); a freeze ignores one.
          await this.audit(tx, input.requestId, actorId, 'identity', hash, result, auditId, {
            fourEyes: approverId !== null,
            ...(input.action === 'restore' && input.approvalId ? { approvalId: input.approvalId } : {}),
          });
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

  /**
   * Trading restriction. The flag is off unless the lead turns it on: off keeps the old refusal
   * (identity does not alter trading) and is handled in `change` before this method.
   * On: a trade-ops operator applies the change only with a bound, unconsumed approval, in this transaction.
   */
  private async changeTrading(context: Context, input: IdentityAccountControlInput): Promise<AccountControlResult> {
    if (input.target.area !== 'trading') throw new FounderControlError('operator.denied', 'Identity controls cannot alter another module');
    const principal = context.principal;
    const actorId = principal?.userId.toLowerCase() ?? null;
    const targetId = input.target.userId.toLowerCase();
    const hash = fingerprint(actorId, input);
    const door = this.tradeOpsRefusal(context);
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const [clock] = await tx<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
          const occurredAt = clock!.at.toISOString();
          const auditId = randomUUID();
          const common = {
            auditId,
            requestId: input.requestId,
            target: { area: 'trading' as const, userId: targetId },
            action: input.action,
            reason: input.reason,
            occurredAt,
            actorUserId: actorId,
          };
          const refuse = (
            code:
              | 'operator.denied'
              | 'mfa.required'
              | 'target.not_found'
              | 'request.conflict'
              | 'restriction_no_four_eyes'
              | 'restriction_approval_mismatch'
              | 'restriction_approval_consumed'
              | 'restriction.reason_unlisted'
              | 'restriction.reason_in_force',
            current: AccountControlState | null,
          ) =>
            accountControlResultSchema.parse({
              ...common,
              outcome: 'refused',
              changed: false,
              code,
              current: code === 'operator.denied' || code === 'mfa.required' ? null : current,
            });
          if (door) {
            const result = refuse(door, null);
            await this.audit(tx, input.requestId, actorId, 'identity', hash, result, auditId, { fourEyes: false, area: 'trading' });
            return result;
          }
          const sessionId = principal!.sid;
          const [session] = await tx<
            Array<{ revoked: boolean; mfa: boolean; expires_at: Date }>
          >`SELECT revoked, mfa, expires_at FROM sessions WHERE id = ${sessionId} AND user_id = ${actorId} FOR UPDATE`;
          if (!session || session.revoked || !session.mfa || session.expires_at.getTime() <= Date.now()) {
            const code = session && !session.mfa ? 'mfa.required' : 'operator.denied';
            const result = refuse(code, null);
            await this.audit(tx, input.requestId, actorId, 'identity', hash, result, auditId, { fourEyes: false, area: 'trading' });
            return result;
          }
          const previous = await this.replay(tx, input.requestId, hash);
          if (previous && !previous.conflict) return accountControlResultSchema.parse(previous.result);
          const [user] = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${targetId} FOR UPDATE`;
          const [stateRow] = await tx<
            Array<{ restricted: boolean; version: string; reason_code: string | null }>
          >`SELECT restricted, version::text, reason_code FROM trading_restrictions WHERE user_id = ${targetId} FOR UPDATE`;
          const before: AccountControlState = {
            target: { area: 'trading', userId: targetId },
            version: stateRow?.version ?? '0',
            restricted: stateRow?.restricted ?? false,
          };
          let result: AccountControlResult;
          if (previous) result = refuse('request.conflict', user ? before : null);
          else if (!user) result = refuse('target.not_found', null);
          else if (before.version !== input.expectedVersion)
            result = accountControlResultSchema.parse({
              ...common,
              outcome: 'conflict',
              changed: false,
              actorUserId: actorId!,
              code: 'restriction.version_conflict',
              current: before,
            });
          else if (
            input.reasonCode !== undefined &&
            (input.action !== 'restrict' || !(this.options.tradingRestrictionReasons ?? new Map()).has(input.reasonCode))
          )
            result = refuse('restriction.reason_unlisted', before);
          // A restriction keeps the reason it was set with: another code on one already in force would spend the approval
          // and change nothing, so it refuses first (restore, then restrict with the new code).
          else if (input.reasonCode !== undefined && before.restricted && (stateRow?.reason_code ?? null) !== input.reasonCode)
            result = refuse('restriction.reason_in_force', before);
          else if (!input.approvalId) result = refuse('restriction_no_four_eyes', before);
          else {
            const approval = await sqlGetApprovalForUpdate(tx, input.approvalId);
            const payloadHash = tradingRestrictPayloadHash({
              userId: targetId,
              action: input.action,
              reason: input.reason,
              expectedVersion: input.expectedVersion,
              ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
            });
            const bound = approval !== null && this.tradingApprovalBound(approval, targetId, payloadHash, input.expectedVersion, clock!.at);
            if (approval?.status === 'CONSUMED') result = refuse('restriction_approval_consumed', before);
            else if (!bound || approval === null) result = refuse('restriction_approval_mismatch', before);
            else {
              const consumed = await sqlCasConsume(tx, {
                approvalId: approval.approvalId,
                operationId: approval.operationId,
                payloadHash: approval.payloadHash,
                targetService: approval.targetService,
                targetId: approval.targetId,
                expectedVersion: approval.expectedVersion,
                now: clock!.at,
                requestId: input.requestId,
                consumedByService: TRADING_RESTRICT_TARGET_SERVICE,
                consumedByPrincipal: actorId,
              });
              if (!consumed) result = refuse('restriction_approval_consumed', before);
              else {
                const restricted = input.action === 'restrict';
                const changed = before.restricted !== restricted;
                const after: AccountControlState = {
                  ...before,
                  restricted,
                  version: changed ? (BigInt(before.version) + 1n).toString() : before.version,
                };
                // The code belongs to the restriction it came with: a restore clears it, and a no-op repeat keeps the
                // restriction's own code, so the customer's reason never changes without a change.
                const reasonCode = restricted ? (input.reasonCode ?? null) : null;
                await tx`INSERT INTO trading_restrictions (user_id, restricted, version, reason_code)
                  VALUES (${targetId}, ${restricted}, ${after.version}::bigint, ${reasonCode})
                  ON CONFLICT (user_id) DO UPDATE SET restricted = EXCLUDED.restricted, version = EXCLUDED.version,
                    reason_code = CASE WHEN ${changed} THEN EXCLUDED.reason_code ELSE trading_restrictions.reason_code END,
                    updated_at = now()`;
                const approverUserId = approval.approverId!.toLowerCase();
                result = changed
                  ? accountControlResultSchema.parse({
                      ...common,
                      actorUserId: actorId!,
                      approverUserId,
                      outcome: 'changed',
                      changed: true,
                      before,
                      after,
                    })
                  : accountControlResultSchema.parse({ ...common, actorUserId: actorId!, outcome: 'noop', changed: false, before, after });
              }
            }
          }
          const fourEyes = result.outcome === 'changed' || result.outcome === 'noop';
          await this.audit(tx, input.requestId, actorId, 'identity', hash, result, auditId, {
            fourEyes,
            area: 'trading',
            ...(input.approvalId ? { approvalId: input.approvalId } : {}),
            ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
          });
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

  /**
   * Lifting an identity freeze takes a second person (J-ops-console-04 #6). The approval must be an approved,
   * unexpired, unconsumed `identity.account_unfreeze` four-eyes row filed against svc-identity for this account,
   * at the version the founder read, over the reason the approver read. The requester must be the founder restoring,
   * the approver someone else, and neither may be the account being restored. It is spent in this transaction.
   * Returns the approver, or the refusal when the row does not bind or was spent (the caller refuses and nothing changes).
   */
  private async consumeUnfreezeApproval(
    tx: Sql,
    input: IdentityAccountControlInput,
    targetId: string,
    actorId: string,
    now: Date,
  ): Promise<UnfreezeApproval> {
    const spent = await this.consumeIdentityApproval(tx, {
      approvalId: input.approvalId!,
      actionType: IDENTITY_UNFREEZE_ACTION_TYPE,
      payloadHash: identityUnfreezePayloadHash({ userId: targetId, reason: input.reason }),
      targetId,
      expectedVersion: input.expectedVersion,
      actorId,
      requestId: input.requestId,
      now,
    });
    if (spent.refusal === null) return { approverId: spent.approverId, refusal: null };
    return { refusal: spent.refusal === 'mismatch' ? 'restriction_approval_mismatch' : 'restriction_approval_consumed' };
  }

  /**
   * One four-eyes approval filed at svc-identity for one account, checked and spent in the caller's transaction:
   * approved, unexpired, unconsumed, of this action type, for this account, payload hash and version; the requester is
   * the actor, the approver someone else, and neither is the account itself. `spend: false` checks it (row locked) and
   * leaves it unspent, so a caller can refuse for its own reasons first.
   */
  private async consumeIdentityApproval(
    tx: Sql,
    want: IdentityApprovalWant,
    spend = true,
  ): Promise<{ readonly approverId: string; readonly refusal: null } | { readonly refusal: 'mismatch' | 'consumed' }> {
    const approval = await sqlGetApprovalForUpdate(tx, want.approvalId);
    if (!approval) return { refusal: 'mismatch' };
    if (approval.status === 'CONSUMED') return { refusal: 'consumed' };
    const requester = approval.requesterId.toLowerCase();
    const approver = approval.approverId?.toLowerCase() ?? null;
    const bound =
      approval.actionType === want.actionType &&
      approval.targetService === 'svc-identity' &&
      approval.targetId.toLowerCase() === want.targetId &&
      approval.payloadHash === want.payloadHash &&
      approval.expectedVersion === want.expectedVersion &&
      approval.status === 'APPROVED' &&
      approval.kind !== 'same_person' &&
      approver !== null &&
      approver !== requester &&
      requester === want.actorId.toLowerCase() &&
      requester !== want.targetId &&
      approver !== want.targetId &&
      approval.expiresAt.getTime() > want.now.getTime();
    if (!bound) return { refusal: 'mismatch' };
    if (!spend) return { approverId: approver, refusal: null };
    const consumed = await sqlCasConsume(tx, {
      approvalId: approval.approvalId,
      operationId: approval.operationId,
      payloadHash: approval.payloadHash,
      targetService: approval.targetService,
      targetId: approval.targetId,
      expectedVersion: approval.expectedVersion,
      now: want.now,
      requestId: want.requestId,
      consumedByService: 'svc-identity',
      consumedByPrincipal: want.actorId,
    });
    return consumed ? { approverId: approver, refusal: null } : { refusal: 'consumed' };
  }

  private tradeOpsRefusal(context: Context): 'operator.denied' | 'mfa.required' | null {
    const principal = context.principal;
    if (!principal || context.service !== null || principal.kid || principal.sub_account || principal.expiresAt.getTime() <= Date.now())
      return 'operator.denied';
    if (!principal.mfa) return 'mfa.required';
    if (!principal.scopes.includes(TRADE_OPS_OPERATOR_PERMISSION)) return 'operator.denied';
    return null;
  }

  private tradingApprovalBound(approval: StoredApproval, userId: string, payloadHash: string, expectedVersion: string, now: Date): boolean {
    return (
      approval.actionType === TRADING_RESTRICT_ACTION_TYPE &&
      approval.targetService === TRADING_RESTRICT_TARGET_SERVICE &&
      approval.targetId.toLowerCase() === userId &&
      approval.payloadHash === payloadHash &&
      approval.expectedVersion === expectedVersion &&
      approval.status === 'APPROVED' &&
      approval.kind !== 'same_person' &&
      approval.approverId !== null &&
      approval.approverId.toLowerCase() !== approval.requesterId.toLowerCase() &&
      approval.expiresAt.getTime() > now.getTime()
    );
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

  /**
   * Is this user a founder right now? Pair membership, an enabled entitlement and an active account, read fresh
   * (no cache). Used to re-check an approval's proposer and approver when it is consumed. Not a founder (or controls
   * not configured) answers `false`. A storage failure THROWS, so the caller can tell "cannot tell" from "no" and
   * still refuse closed.
   */
  async isLiveFounder(userId: string, query?: Sql): Promise<boolean> {
    const parsed = canonicalUuid.safeParse(userId);
    if (!parsed.success || !this.configured || !this.pair || !this.pair.includes(parsed.data)) return false;
    const sql = query ?? this.sql;
    const rows = await sql<
      Array<{ enabled: boolean; status: string }>
    >`SELECT e.enabled, u.status FROM founder_operator_entitlements e JOIN users u ON u.id = e.user_id WHERE e.user_id = ${parsed.data}`;
    return rows[0]?.enabled === true && rows[0].status === 'active';
  }

  /**
   * Service-only read for the services that gate an operator action (trade, pay, ops). The caller's service
   * signature is the only credential; it names the user and the session it already authenticated at the edge.
   * Pair membership, the revocable entitlement, an active account with a verified second factor, and a live,
   * unexpired, MFA session of that same user are all read fresh. It carries no principal and grants no authority
   * beyond answering the question, so a caller cannot mint a user by holding a key.
   */
  async serviceOperatorEntitlement(context: Context, input: ServiceOperatorEntitlementInput): Promise<AccountOperatorEntitlement> {
    const userId = canonicalUuid.parse(input.userId);
    const sessionId = canonicalUuid.parse(input.sessionId);
    if (!context.service || !SERVICE_OPERATOR_READERS.includes(context.service))
      throw new FounderControlError('operator.denied', 'Service is not allowed to read operator entitlement');
    if (!this.configured || !this.pair) return { userId, status: 'unconfigured' };
    if (!this.pair.includes(userId)) return { userId, status: 'not_operator' };
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const [session] = await tx<
            SessionRow[]
          >`SELECT id, user_id, revoked, mfa, expires_at FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} FOR UPDATE`;
          const [user] = await tx<
            UserRow[]
          >`SELECT id, status, identity_control_version::text, totp_enrolled_at, totp_secret, webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE`;
          const [row] = await tx<
            EntitlementRow[]
          >`SELECT user_id, enabled, version::text, changed_at FROM founder_operator_entitlements WHERE user_id = ${userId} FOR UPDATE`;
          if (!serviceOperatorLive(userId, user, session, row)) {
            return row && !row.enabled
              ? accountOperatorEntitlementSchema.parse({
                  userId,
                  status: 'revoked',
                  version: row.version,
                  changedAt: row.changed_at.toISOString(),
                })
              : { userId, status: 'not_operator' as const };
          }
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

  /**
   * Staff close or reopen of one account (J-ops-console-04 #7). A live founder runs it with a four-eyes approval a second
   * person gave, spent here. A close needs a reason code, refuses founders and the actor's own account, and refuses while
   * the closure checks report open products or balances (they run before the approval is spent). It closes the account
   * the way the closure job does (status closed, sessions, API keys and sub-accounts revoked). A reopen is allowed only
   * for a customer-closed account. Each attempt, refused ones included, is in the closure history; a retry of the same
   * request id returns the stored answer.
   */
  async closure(context: Context, raw: AccountClosureInput): Promise<AccountClosureResult> {
    const input = accountClosureInputSchema.parse(raw);
    input.requestId = input.requestId.toLowerCase();
    input.userId = input.userId.toLowerCase();
    const targetId = input.userId;
    const actorId = context.principal?.userId.toLowerCase() ?? null;
    const hash = fingerprint(actorId, { kind: 'closure', ...input });
    // The closure checks call svc-bank, svc-trade and svc-p2p, so they run before the founder-controls lock is taken
    // (that lock also serialises trade and pay admission). Only a close carrying an approval from a principal that can be
    // a live founder gets this far; the transaction below re-checks everything else before it uses the answer.
    const principal = context.principal;
    const mayCheck =
      input.action === 'close' &&
      !!input.approvalId &&
      this.configured &&
      !!principal &&
      context.service === null &&
      !principal.kid &&
      !principal.sub_account &&
      principal.mfa &&
      !!this.pair?.includes(principal.userId.toLowerCase()) &&
      (await this.closeApprovalLooksBound(input, actorId!));
    const checks = mayCheck ? await this.runClosureChecks(targetId) : null;
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
            userId: targetId,
            action: input.action,
            reasonCode: input.action === 'close' ? input.reasonCode : null,
            reason: input.reason,
            occurredAt: clock!.at.toISOString(),
          };
          const refused = (
            code: ClosureRefusal,
            current: AccountClosureState | null = null,
            blockers?: readonly { code: string; count: number }[],
          ) =>
            accountClosureResultSchema.parse({
              ...common,
              outcome: 'refused',
              changed: false,
              actorUserId: actorId,
              code,
              current,
              ...(blockers ? { blockers: blockers.slice(0, 50) } : {}),
            });
          const finish = async (result: AccountClosureResult, store: boolean) => {
            await this.audit(tx, input.requestId, actorId, 'closure', hash, result, auditId, {
              fourEyes: result.outcome === 'changed',
              ...(input.approvalId ? { approvalId: input.approvalId } : {}),
            });
            if (store)
              await tx`INSERT INTO founder_control_requests (request_id, actor_id, fingerprint, audit_id) VALUES (${input.requestId}, ${actorId!}, ${hash}, ${auditId})`;
            return result;
          };
          if (actor.refusal) return finish(refused(actor.refusal), false);
          const previous = await this.replay(tx, input.requestId, hash);
          if (previous && !previous.conflict) return accountClosureResultSchema.parse(previous.result);
          if (previous) return finish(refused('request.conflict'), false);
          const user = actor.users.find((row) => row.id === targetId);
          if (!user) return finish(refused('target.not_found'), true);
          const before = (await this.closureStateOf(tx, targetId))!;
          // An archived record stays closed for good (J-ops-console-04 #10).
          if (user.archived_at) return finish(refused('identity.account_archived', before), true);
          if (before.version !== input.expectedVersion)
            return finish(
              accountClosureResultSchema.parse({
                ...common,
                outcome: 'conflict',
                changed: false,
                actorUserId: actorId,
                code: 'restriction.version_conflict',
                current: before,
              }),
              true,
            );
          if (input.action === 'close') {
            if (this.pair?.includes(targetId)) return finish(refused('identity.close_founder_forbidden', before), true);
            if (targetId === actorId) return finish(refused('identity.close_self_forbidden', before), true);
            if (before.status === 'closed') return finish(refused('identity.close_already_closed', before), true);
          } else {
            if (before.status !== 'closed') return finish(refused('identity.reopen_not_closed', before), true);
            if (!before.reopenable) return finish(refused('identity.reopen_not_allowed', before), true);
          }
          if (!input.approvalId) return finish(refused('identity.close_requires_approver', before), true);
          const want = {
            approvalId: input.approvalId,
            actionType: input.action === 'close' ? IDENTITY_CLOSE_ACTION_TYPE : IDENTITY_REOPEN_ACTION_TYPE,
            payloadHash: identityClosurePayloadHash(input),
            targetId,
            expectedVersion: input.expectedVersion,
            actorId: actorId!,
            requestId: input.requestId,
            now: clock!.at,
          };
          const approvalRefusal = (refusal: 'mismatch' | 'consumed') =>
            refused(refusal === 'mismatch' ? 'identity.close_approval_mismatch' : 'identity.close_approval_consumed', before);
          const bound = await this.consumeIdentityApproval(tx, want, false);
          if (bound.refusal) return finish(approvalRefusal(bound.refusal), true);
          if (input.action === 'close') {
            if (!checks?.ok) return finish(refused('identity.close_check_unavailable', before), true);
            if (checks.blockers.length > 0) return finish(refused('identity.close_blocked', before, checks.blockers), true);
          }
          const spent = await this.consumeIdentityApproval(tx, want);
          if (spent.refusal) return finish(approvalRefusal(spent.refusal), true);
          if (input.action === 'close') {
            await tx`UPDATE users SET status = 'closed', closed_reason = ${input.reasonCode}, closed_from_frozen = (status = 'frozen'), identity_control_version = identity_control_version + 1, updated_at = now() WHERE id = ${targetId}`;
            await tx`UPDATE sessions SET revoked = true WHERE user_id = ${targetId} AND revoked = false`;
            await tx`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'account_closed' WHERE user_id = ${targetId} AND revoked = false`;
            await tx`UPDATE sub_accounts SET revoked = true WHERE parent_user_id = ${targetId} AND revoked = false`;
            await tx`UPDATE navigator_session_projections SET status = 'closed', published_at = now() WHERE user_id = ${targetId} AND status = 'open'`;
          } else {
            // A freeze in force when it was closed comes back with it: lifting that needs its own unfreeze approval.
            const [flags] = await tx<Array<{ closed_from_frozen: boolean }>>`SELECT closed_from_frozen FROM users WHERE id = ${targetId}`;
            const reopened = flags?.closed_from_frozen ? 'frozen' : 'active';
            await tx`UPDATE users SET status = ${reopened}, closed_reason = NULL, closed_from_frozen = false, identity_control_version = identity_control_version + 1, updated_at = now() WHERE id = ${targetId}`;
          }
          const after = (await this.closureStateOf(tx, targetId))!;
          return finish(
            accountClosureResultSchema.parse({
              ...common,
              outcome: 'changed',
              changed: true,
              actorUserId: actorId,
              approverUserId: spent.approverId,
              before,
              after,
            }),
            true,
          );
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  async closureState(context: Context, raw: z.infer<typeof accountClosureLookupInputSchema>): Promise<AccountClosureState | null> {
    const input = accountClosureLookupInputSchema.parse(raw);
    const userId = input.userId.toLowerCase();
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context);
          if (actor.refusal) throw new FounderControlError(actor.refusal, 'Live founder authority is required');
          return this.closureStateOf(tx, userId);
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  async closureHistory(context: Context, raw: z.infer<typeof accountClosureHistoryInputSchema>): Promise<AccountClosureResult[]> {
    const input = accountClosureHistoryInputSchema.parse(raw);
    const userId = input.userId.toLowerCase();
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context);
          if (actor.refusal) throw new FounderControlError(actor.refusal, 'Live founder authority is required');
          const rows = await tx<
            Array<{ result: unknown }>
          >`SELECT result FROM founder_control_audit WHERE kind = 'closure' AND result->>'userId' = ${userId} ORDER BY created_at DESC, audit_id DESC LIMIT ${input.limit}`;
          return rows.map((row) => accountClosureResultSchema.parse(row.result));
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  /**
   * Staff archive of one customer record (J-ops-console-04 #10). A live founder runs it with a four-eyes approval a second
   * person gave, spent here. Only a closed account can be archived; founders and the actor's own record cannot. It sets
   * `archived_at` and the reason code once and never clears them: afterwards freeze, unfreeze and reopen refuse
   * `identity.account_archived`. Each attempt, refused ones included, is in the archive history; a retry of the same
   * request id, or a new run of the same founder's spent approval, returns the stored answer.
   */
  async archive(context: Context, raw: AccountArchiveInput): Promise<AccountArchiveResult> {
    const input = accountArchiveInputSchema.parse(raw);
    input.requestId = input.requestId.toLowerCase();
    input.userId = input.userId.toLowerCase();
    const targetId = input.userId;
    const actorId = context.principal?.userId.toLowerCase() ?? null;
    const hash = fingerprint(actorId, { kind: 'archive', ...input });
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
            userId: targetId,
            reasonCode: input.reasonCode,
            reason: input.reason,
            occurredAt: clock!.at.toISOString(),
          };
          type ArchiveRefusal = Extract<AccountArchiveResult, { outcome: 'refused' }>['code'];
          const refused = (code: ArchiveRefusal, current: AccountArchiveState | null = null) =>
            accountArchiveResultSchema.parse({ ...common, outcome: 'refused', changed: false, actorUserId: actorId, code, current });
          const finish = async (result: AccountArchiveResult, store: boolean) => {
            await this.audit(tx, input.requestId, actorId, 'archive', hash, result, auditId, {
              fourEyes: result.outcome === 'changed',
              ...(input.approvalId ? { approvalId: input.approvalId } : {}),
            });
            if (store)
              await tx`INSERT INTO founder_control_requests (request_id, actor_id, fingerprint, audit_id) VALUES (${input.requestId}, ${actorId!}, ${hash}, ${auditId})`;
            return result;
          };
          if (actor.refusal) return finish(refused(actor.refusal), false);
          const previous = await this.replay(tx, input.requestId, hash);
          if (previous && !previous.conflict) return accountArchiveResultSchema.parse(previous.result);
          if (previous) return finish(refused('request.conflict'), false);
          const user = actor.users.find((row) => row.id === targetId);
          if (!user) return finish(refused('target.not_found'), true);
          const before = (await this.archiveStateOf(tx, targetId))!;
          if (before.archivedAt !== null) {
            // A run whose answer was lost: the same founder, approval and request archived it already, so answer as then.
            const [done] = input.approvalId
              ? await tx<Array<{ result: unknown }>>`
                  SELECT result FROM founder_control_audit
                   WHERE kind = 'archive' AND actor_id = ${actorId!} AND detail->>'approvalId' = ${input.approvalId}
                     AND result->>'outcome' = 'changed' AND result->>'userId' = ${targetId}
                   LIMIT 1`
              : [];
            const stored = done ? accountArchiveResultSchema.parse(done.result) : null;
            if (stored && stored.reasonCode === input.reasonCode && stored.reason === input.reason) return stored;
            return finish(refused('identity.account_archived', before), true);
          }
          // Refusals no later version can lift come before the version check, so a stale request is not sent round again.
          if (this.pair?.includes(targetId)) return finish(refused('identity.archive_founder_forbidden', before), true);
          if (targetId === actorId) return finish(refused('identity.archive_self_forbidden', before), true);
          if (before.version !== input.expectedVersion)
            return finish(
              accountArchiveResultSchema.parse({
                ...common,
                outcome: 'conflict',
                changed: false,
                actorUserId: actorId,
                code: 'restriction.version_conflict',
                current: before,
              }),
              true,
            );
          if (before.status !== 'closed') return finish(refused('identity.archive_blocked_open_account', before), true);
          if (!input.approvalId) return finish(refused('identity.archive_requires_approver', before), true);
          const want = {
            approvalId: input.approvalId,
            actionType: IDENTITY_ARCHIVE_ACTION_TYPE,
            payloadHash: identityArchivePayloadHash(input),
            targetId,
            expectedVersion: input.expectedVersion,
            actorId: actorId!,
            requestId: input.requestId,
            now: clock!.at,
          };
          const approvalRefusal = (refusal: 'mismatch' | 'consumed') =>
            refused(refusal === 'mismatch' ? 'identity.archive_approval_mismatch' : 'identity.archive_approval_consumed', before);
          const bound = await this.consumeIdentityApproval(tx, want, false);
          if (bound.refusal) return finish(approvalRefusal(bound.refusal), true);
          // Founder-level: an archive cannot be undone, so the approver must be the other live founder, not any operator.
          if (!(await this.isLiveFounder(bound.approverId, tx))) return finish(approvalRefusal('mismatch'), true);
          const spent = await this.consumeIdentityApproval(tx, want);
          if (spent.refusal) return finish(approvalRefusal(spent.refusal), true);
          await tx`UPDATE users SET archived_at = ${clock!.at}, archive_reason = ${input.reasonCode}, identity_control_version = identity_control_version + 1, updated_at = now() WHERE id = ${targetId}`;
          const after = (await this.archiveStateOf(tx, targetId))!;
          return finish(
            accountArchiveResultSchema.parse({
              ...common,
              outcome: 'changed',
              changed: true,
              actorUserId: actorId,
              approverUserId: spent.approverId,
              before,
              after,
            }),
            true,
          );
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  async archiveState(context: Context, raw: z.infer<typeof accountArchiveLookupInputSchema>): Promise<AccountArchiveState | null> {
    const input = accountArchiveLookupInputSchema.parse(raw);
    const userId = input.userId.toLowerCase();
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context);
          if (actor.refusal) throw new FounderControlError(actor.refusal, 'Live founder authority is required');
          return this.archiveStateOf(tx, userId);
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  async archiveHistory(context: Context, raw: z.infer<typeof accountArchiveHistoryInputSchema>): Promise<AccountArchiveResult[]> {
    const input = accountArchiveHistoryInputSchema.parse(raw);
    const userId = input.userId.toLowerCase();
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context);
          if (actor.refusal) throw new FounderControlError(actor.refusal, 'Live founder authority is required');
          const rows = await tx<
            Array<{ result: unknown }>
          >`SELECT result FROM founder_control_audit WHERE kind = 'archive' AND result->>'userId' = ${userId} ORDER BY created_at DESC, audit_id DESC LIMIT ${input.limit}`;
          return rows.map((row) => accountArchiveResultSchema.parse(row.result));
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  /**
   * Customers to propose for archive: closed, not archived, no change to the record and no new session for the owner's
   * dormancy period. Read when asked, never acted on: a person archives each with a second approver. With the period unset
   * the answer is `dormancyDays: null` and no proposal.
   */
  async archiveProposals(context: Context): Promise<AccountArchiveProposals> {
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context);
          if (actor.refusal) throw new FounderControlError(actor.refusal, 'Live founder authority is required');
          const [clock] = await tx<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
          const days = this.dormancyDays;
          if (days === null)
            return accountArchiveProposalsSchema.parse({ dormancyDays: null, proposals: [], asOf: clock!.at.toISOString() });
          // Activity is the latest change to the record, sign-in, or customer closure (which does not touch updated_at).
          const rows = await tx<Array<{ id: string; last_activity_at: Date }>>`
            SELECT id, last_activity_at FROM (
              SELECT u.id, GREATEST(
                       u.updated_at,
                       (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id),
                       (SELECT MAX(c.finalized_at) FROM account_closures c WHERE c.user_id = u.id)
                     ) AS last_activity_at
                FROM users u
               WHERE u.status = 'closed' AND u.archived_at IS NULL AND u.id <> ALL(${tx.array([...(this.pair ?? [])])}::uuid[])
            ) dormant
             WHERE last_activity_at < ${clock!.at}::timestamptz - make_interval(days => ${days})
             ORDER BY last_activity_at, id
             LIMIT 200`;
          return accountArchiveProposalsSchema.parse({
            dormancyDays: days,
            proposals: rows.map((row) => ({ userId: row.id, lastActivityAt: row.last_activity_at.toISOString() })),
            asOf: clock!.at.toISOString(),
          });
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  private async archiveStateOf(tx: Sql, userId: string): Promise<AccountArchiveState | null> {
    const [row] = await tx<
      Array<{
        status: 'active' | 'frozen' | 'closed';
        version: string;
        archived_at: Date | null;
        archive_reason: AccountArchiveReasonCode | null;
      }>
    >`SELECT status, identity_control_version::text AS version, archived_at, archive_reason FROM users WHERE id = ${userId}`;
    if (!row) return null;
    return {
      userId,
      version: row.version,
      status: row.status,
      archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
      archiveReasonCode: row.archive_reason,
    };
  }

  /** The tiers on offer, for a live founder. Unset is its own answer, never an empty list. */
  async tiers(context: Context): Promise<AccountTierList> {
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context);
          if (actor.refusal) throw new FounderControlError(actor.refusal, 'Live founder authority is required');
          return this.accountTiers
            ? { configured: true as const, tiers: [...this.accountTiers] }
            : { configured: false as const, code: 'identity.account_tiers_unset' as const };
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  /**
   * Move one account onto another product tier (J-ops-console-04 #11). A live founder runs it with a founder-level
   * four-eyes approval a second live founder gave, spent here. Refused while the tiers are unset, for an unknown tier, a
   * tier with any blank term (naming them), the tier the account is already on, the actor's own account or a closed
   * account. Each attempt, refused ones included, is in the tier history; a retry of the same request id returns the
   * stored answer. Nothing here moves money: the terms are the owner's record of the tier.
   */
  async tierMove(context: Context, raw: AccountTierMoveInput): Promise<AccountTierResult> {
    const input = accountTierMoveInputSchema.parse(raw);
    input.requestId = input.requestId.toLowerCase();
    input.userId = input.userId.toLowerCase();
    const targetId = input.userId;
    const actorId = context.principal?.userId.toLowerCase() ?? null;
    const hash = fingerprint(actorId, { kind: 'tier', ...input });
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
            userId: targetId,
            tierId: input.tierId,
            reason: input.reason,
            occurredAt: clock!.at.toISOString(),
          };
          type TierRefusal = Extract<AccountTierResult, { outcome: 'refused' }>['code'];
          const refused = (code: TierRefusal, current: AccountTierState | null = null, blankTerms?: readonly string[]) =>
            accountTierResultSchema.parse({
              ...common,
              outcome: 'refused',
              changed: false,
              actorUserId: actorId,
              code,
              current,
              ...(blankTerms ? { blankTerms } : {}),
            });
          const finish = async (result: AccountTierResult, store: boolean) => {
            await this.audit(tx, input.requestId, actorId, 'tier', hash, result, auditId, {
              fourEyes: result.outcome === 'changed',
              ...(input.approvalId ? { approvalId: input.approvalId } : {}),
            });
            if (store)
              await tx`INSERT INTO founder_control_requests (request_id, actor_id, fingerprint, audit_id) VALUES (${input.requestId}, ${actorId!}, ${hash}, ${auditId})`;
            return result;
          };
          if (actor.refusal) return finish(refused(actor.refusal), false);
          const previous = await this.replay(tx, input.requestId, hash);
          if (previous && !previous.conflict) return accountTierResultSchema.parse(previous.result);
          if (previous) return finish(refused('request.conflict'), false);
          const user = actor.users.find((row) => row.id === targetId);
          if (!user) return finish(refused('target.not_found'), true);
          const before = await this.tierStateOf(tx, targetId);
          if (before.version !== input.expectedVersion)
            return finish(
              accountTierResultSchema.parse({
                ...common,
                outcome: 'conflict',
                changed: false,
                actorUserId: actorId,
                code: 'restriction.version_conflict',
                current: before,
              }),
              true,
            );
          if (targetId === actorId) return finish(refused('identity.tier_self_forbidden', before), true);
          if (user.status === 'closed') return finish(refused('identity.tier_account_closed', before), true);
          if (!this.accountTiers) return finish(refused('identity.account_tiers_unset', before), true);
          const tier = this.accountTiers.find((row) => row.id === input.tierId);
          if (!tier) return finish(refused('identity.tier_unknown', before), true);
          if (before.tierId === tier.id) return finish(refused('identity.tier_unchanged', before), true);
          const blank = blankTierTerms(tier.terms);
          if (blank.length > 0) return finish(refused('identity.tier_terms_unset', before, blank), true);
          if (!input.approvalId) return finish(refused('identity.tier_requires_approver', before), true);
          const want = {
            approvalId: input.approvalId,
            actionType: IDENTITY_TIER_MOVE_ACTION_TYPE,
            payloadHash: identityTierPayloadHash(input),
            targetId,
            expectedVersion: input.expectedVersion,
            actorId: actorId!,
            requestId: input.requestId,
            now: clock!.at,
          };
          const approvalRefusal = (refusal: 'mismatch' | 'consumed') =>
            refused(refusal === 'mismatch' ? 'identity.tier_approval_mismatch' : 'identity.tier_approval_consumed', before);
          const bound = await this.consumeIdentityApproval(tx, want, false);
          if (bound.refusal) return finish(approvalRefusal(bound.refusal), true);
          // Founder-level: the approver must still be a live founder now, not only when they approved.
          if (!(await this.isLiveFounder(bound.approverId, tx))) return finish(approvalRefusal('mismatch'), true);
          const spent = await this.consumeIdentityApproval(tx, want);
          if (spent.refusal) return finish(approvalRefusal(spent.refusal), true);
          await tx`INSERT INTO account_tier_assignments (user_id, tier_id, version, updated_at) VALUES (${targetId}, ${tier.id}, 1, now())
            ON CONFLICT (user_id) DO UPDATE SET tier_id = EXCLUDED.tier_id, version = account_tier_assignments.version + 1, updated_at = now()`;
          const after = await this.tierStateOf(tx, targetId);
          return finish(
            accountTierResultSchema.parse({
              ...common,
              outcome: 'changed',
              changed: true,
              actorUserId: actorId,
              approverUserId: spent.approverId,
              before,
              after,
            }),
            true,
          );
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  async tierState(context: Context, raw: z.infer<typeof accountTierLookupInputSchema>): Promise<AccountTierState | null> {
    const input = accountTierLookupInputSchema.parse(raw);
    const userId = input.userId.toLowerCase();
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context);
          if (actor.refusal) throw new FounderControlError(actor.refusal, 'Live founder authority is required');
          const [user] = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId}`;
          return user ? this.tierStateOf(tx, userId) : null;
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  async tierHistory(context: Context, raw: z.infer<typeof accountTierHistoryInputSchema>): Promise<AccountTierResult[]> {
    const input = accountTierHistoryInputSchema.parse(raw);
    const userId = input.userId.toLowerCase();
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await this.lock(tx);
          const actor = await this.actor(tx, context);
          if (actor.refusal) throw new FounderControlError(actor.refusal, 'Live founder authority is required');
          const rows = await tx<
            Array<{ result: unknown }>
          >`SELECT result FROM founder_control_audit WHERE kind = 'tier' AND result->>'userId' = ${userId} ORDER BY created_at DESC, audit_id DESC LIMIT ${input.limit}`;
          return rows.map((row) => accountTierResultSchema.parse(row.result));
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      throw storageError(error);
    }
  }

  /** No row: never put on a tier, version 0. */
  private async tierStateOf(tx: Sql, userId: string): Promise<AccountTierState> {
    const [row] = await tx<
      Array<{ tier_id: string; version: string }>
    >`SELECT tier_id, version::text AS version FROM account_tier_assignments WHERE user_id = ${userId}`;
    return { userId, version: row?.version ?? '0', tierId: row?.tier_id ?? null };
  }

  /**
   * Account state as the closure desk reads it. Customer-closed: the customer finalised a closure (account_closures) and
   * staff gave no other code, or staff closed it with `customer_request`. Only a customer-closed account can be reopened.
   */
  private async closureStateOf(tx: Sql, userId: string): Promise<AccountClosureState | null> {
    const [row] = await tx<
      Array<{
        status: 'active' | 'frozen' | 'closed';
        version: string;
        closed_reason: AccountCloseReasonCode | null;
        customer_closed: boolean;
        archived: boolean;
      }>
    >`SELECT status, identity_control_version::text AS version, closed_reason,
         EXISTS (SELECT 1 FROM account_closures c WHERE c.user_id = users.id AND c.status = 'closed') AS customer_closed,
         archived_at IS NOT NULL AS archived
       FROM users WHERE id = ${userId}`;
    if (!row) return null;
    const closed = row.status === 'closed';
    const customerClosed = closed && (row.closed_reason === 'customer_request' || (row.closed_reason === null && row.customer_closed));
    return {
      userId,
      version: row.version,
      status: row.status,
      closedBy: closed ? (customerClosed ? 'customer' : 'staff') : null,
      closeReasonCode: closed ? row.closed_reason : null,
      // An archived record is never reopened (identity.account_archived).
      reopenable: customerClosed && !row.archived,
    };
  }

  /** A cheap read, outside the lock, so an approval that cannot bind does not cost three service calls. Not authority. */
  private async closeApprovalLooksBound(input: AccountClosureInput, actorId: string): Promise<boolean> {
    try {
      const approval = await sqlGetApprovalForUpdate(this.sql, input.approvalId!);
      return (
        !!approval &&
        approval.status === 'APPROVED' &&
        approval.actionType === IDENTITY_CLOSE_ACTION_TYPE &&
        approval.targetService === 'svc-identity' &&
        approval.targetId.toLowerCase() === input.userId &&
        approval.payloadHash === identityClosurePayloadHash(input) &&
        approval.expectedVersion === input.expectedVersion &&
        approval.requesterId.toLowerCase() === actorId
      );
    } catch {
      return false;
    }
  }

  private async runClosureChecks(
    userId: string,
  ): Promise<{ ok: true; blockers: readonly { code: string; count: number }[] } | { ok: false }> {
    if (!this.closureChecks) return { ok: false };
    try {
      const subs = await this.sql<Array<{ id: string }>>`SELECT id::text AS id FROM sub_accounts WHERE parent_user_id = ${userId}`;
      return await this.closureChecks({ userId, subAccountIds: subs.map((row) => row.id) });
    } catch {
      return { ok: false };
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

  async listRestricted(
    context: Context,
    input: { area?: 'identity' | 'trading' | undefined; limit?: number | null | undefined; cursor?: string | undefined },
  ): Promise<RestrictedAccountPage> {
    assertRestrictedListReader(context);
    try {
      return await listRestrictedAccounts(this.sql, input);
    } catch (error) {
      if (error instanceof FounderControlError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null;
      if (code === '42P01' || code === '42703') throw storageError(error);
      throw error;
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
          Array<{ id: string; status: string; identity_control_version: string; archived: boolean }>
        >`SELECT id, status, identity_control_version::text, archived_at IS NOT NULL AS archived FROM users WHERE id = ${input.userId}`;
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
            Array<{ id: string; parent_user_id: string; revoked: boolean; frozen: number | string }>
          >`SELECT id, parent_user_id, revoked, frozen FROM sub_accounts WHERE id = ${input.subAccountId}`;
          if (!sub || sub.parent_user_id !== input.userId || sub.revoked || Number(sub.frozen) !== 0) {
            return denied('auth.sub_account_denied');
          }
          subAccount = { id: sub.id, parentUserId: sub.parent_user_id, revoked: false };
        }
        const [kyc] = await tx<
          Array<{ tier: 'none' | 'basic' | 'full' | 'institutional' }>
        >`SELECT tier FROM kyc_records WHERE user_id = ${input.userId} AND status = 'approved' AND (expires_at IS NULL OR expires_at > ${checkedAt}) ORDER BY CASE tier WHEN 'institutional' THEN 3 WHEN 'full' THEN 2 WHEN 'basic' THEN 1 ELSE 0 END DESC LIMIT 1`;
        return currentAuthorityResultSchema.parse({
          ...common,
          status: 'eligible',
          account: { userId: input.userId, status: 'active', kycTier: kyc?.tier ?? 'none', archived: user.archived },
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
