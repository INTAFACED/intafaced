import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { compare, parseAmount } from '@intafaced/ledger-client';
import {
  accountLimitAmountSchema,
  accountLimitAssetIdSchema,
  accountLimitOverrideClearInputSchema,
  accountLimitOverrideReadSchema,
  accountLimitOverrideSchema,
  accountLimitOverrideSetInputSchema,
  accountLimitPolicySchema,
  accountLimitRailSchema,
  accountLimitResultSchema,
  accountLimitsHistoryInputSchema,
  accountLimitsLookupInputSchema,
  accountLimitsStateSchema,
  ACCOUNT_LIMIT_RAILS,
  type AccountLimitCeiling,
  type AccountLimitOverride,
  type AccountLimitOverrideClearInput,
  type AccountLimitOverrideRead,
  type AccountLimitOverrideSetInput,
  type AccountLimitPolicy,
  type AccountLimitRail,
  type AccountLimitResult,
  type AccountLimitsState,
  type Context,
} from '@intafaced/contracts';
import { IDENTITY_LIMIT_CHANGE_ACTION_TYPE } from '../auth/action-approval-audience.js';
import { identityActionPayloadHash } from '../auth/privileged-dual-control.js';
import { FounderControlError, type FounderControls, type UserRow } from './founder-controls.js';

/**
 * Account limit overrides (J-ops-console-04 #12, OPS-accounts-desk-03). A live founder sets a temporary override of one
 * rail's limit figures (per transaction, rolling 24 hours) for one customer and asset, with a reason and a stored expiry.
 * It applies until that time and then the base limit is back; the base limits stay with the service that enforces them
 * (svc-pay's withdrawal limits, D-148), which reads the override in force per request (`overrideInForce`). An override
 * above the owner ceiling for its rail and asset needs a founder-level `identity.change_limit` approval from the other
 * founder, spent here once. A founder may also end an override early. Nothing here moves money.
 *
 * The owner policy (`IDENTITY_LIMIT_OVERRIDE_POLICY`) ships blank: unset, every set refuses `identity.limit_ceiling_unset`
 * and the console says "not set". Every founder attempt, refused ones included, is kept in an append-only history; a
 * caller who is not a live founder is answered and leaves no row.
 */

type LimitRefusal = Extract<AccountLimitResult, { outcome: 'refused' }>['code'];
type OverrideRow = {
  user_id: string;
  rail: AccountLimitRail;
  asset_id: string;
  version: string;
  per_tx: string | null;
  rolling_24h: string | null;
  expires_at: Date;
  set_by: string;
  approved_by: string | null;
  set_at: Date;
  reason: string;
  cleared_by: string | null;
  cleared_at: Date | null;
};

const policyWire = z
  .object({
    maxLifetimeHours: z.string().regex(/^[1-9]\d{0,3}$/),
    ceilings: z.record(z.string(), z.record(z.string(), z.string())),
  })
  .strict();

const UNSET_POLICY: AccountLimitPolicy = { configured: false, code: 'identity.limit_ceiling_unset' };

/**
 * `IDENTITY_LIMIT_OVERRIDE_POLICY`, parsed: `{ "maxLifetimeHours": "720", "ceilings": { "withdrawal": { "USDT": "5000" } } }`.
 * Blank, not JSON, an unknown rail, a bad asset id, a ceiling that is not a positive decimal, more than 8784 hours or more
 * than 100 ceilings all mean unset. Nothing is filled in.
 */
export function parseLimitPolicy(raw: string | undefined): AccountLimitPolicy {
  if (raw === undefined || raw.trim() === '') return UNSET_POLICY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return UNSET_POLICY;
  }
  const wire = policyWire.safeParse(parsed);
  if (!wire.success || Number(wire.data.maxLifetimeHours) > 8784) return UNSET_POLICY;
  const ceilings: AccountLimitCeiling[] = [];
  for (const [rail, assets] of Object.entries(wire.data.ceilings)) {
    if (!accountLimitRailSchema.safeParse(rail).success) return UNSET_POLICY;
    for (const [assetId, ceiling] of Object.entries(assets)) {
      if (!accountLimitAssetIdSchema.safeParse(assetId).success || !accountLimitAmountSchema.safeParse(ceiling).success)
        return UNSET_POLICY;
      ceilings.push({ rail: rail as AccountLimitRail, assetId, ceiling });
    }
  }
  const policy = accountLimitPolicySchema.safeParse({ configured: true, maxLifetimeHours: wire.data.maxLifetimeHours, ceilings });
  return policy.success ? policy.data : UNSET_POLICY;
}

/** Whether a limit figure goes above another, compared as the ledger's scaled integers (never a float). */
export function limitAbove(figure: string, ceiling: string): boolean {
  return compare(parseAmount(figure), parseAmount(ceiling)) > 0;
}

/** Two figures (or two "keep the base figure") that mean the same amount, whatever their spelling: 3000 and 3000.00. */
function sameFigure(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : compare(parseAmount(a), parseAmount(b)) === 0;
}

/**
 * Canonical payload hash for `identity.change_limit`: the account, rail, asset, both figures (blank for "keep the base"),
 * the expiry as an ISO instant and the reason. The console computes the same before it files the approval; the override's
 * version is bound on the approval row, not in the hash.
 */
export function identityLimitPayloadHash(input: {
  readonly userId: string;
  readonly rail: string;
  readonly assetId: string;
  readonly perTx: string | null;
  readonly rolling24h: string | null;
  readonly expiresAt: string;
  readonly reason: string;
}): string {
  return identityActionPayloadHash(input.userId.toLowerCase(), {
    action: 'limit_override',
    rail: input.rail,
    assetId: input.assetId,
    perTx: input.perTx ?? '',
    rolling24h: input.rolling24h ?? '',
    expiresAt: new Date(input.expiresAt).toISOString(),
    reason: input.reason.trim(),
  });
}

function overrideOf(row: OverrideRow, now: Date): AccountLimitOverride {
  return accountLimitOverrideSchema.parse({
    userId: row.user_id,
    rail: row.rail,
    assetId: row.asset_id,
    version: row.version,
    perTx: row.per_tx,
    rolling24h: row.rolling_24h,
    expiresAt: row.expires_at.toISOString(),
    status: row.cleared_at ? 'cleared' : row.expires_at.getTime() > now.getTime() ? 'active' : 'expired',
    setBy: row.set_by,
    approvedBy: row.approved_by,
    setAt: row.set_at.toISOString(),
    reason: row.reason,
    clearedBy: row.cleared_by,
    clearedAt: row.cleared_at?.toISOString() ?? null,
  });
}

export class AccountLimitsDesk {
  constructor(
    private readonly sql: Sql,
    private readonly controls: Pick<FounderControls, 'founderStep' | 'spendFounderApproval'>,
    private readonly policy: AccountLimitPolicy,
  ) {}

  private ceilingOf(rail: AccountLimitRail, assetId: string): string | null {
    if (!this.policy.configured) return null;
    return this.policy.ceilings.find((row) => row.rail === rail && row.assetId === assetId)?.ceiling ?? null;
  }

  private async row(tx: Sql, userId: string, rail: AccountLimitRail, assetId: string): Promise<OverrideRow | undefined> {
    const [row] = await tx<OverrideRow[]>`SELECT user_id, rail, asset_id, version::text AS version, per_tx, rolling_24h, expires_at,
        set_by, approved_by, set_at, reason, cleared_by, cleared_at
      FROM account_limit_overrides WHERE user_id = ${userId} AND rail = ${rail} AND asset_id = ${assetId} FOR UPDATE`;
    return row;
  }

  /** Runs one write door: refusals, the request-id replay and the history row are the same for a set and a clear. */
  private async step(
    context: Context,
    request: { requestId: string; userId: string; action: 'set' | 'clear'; rail: AccountLimitRail; assetId: string; reason: string },
    input: unknown,
    body: (
      tx: Sql,
      kit: {
        actorId: string;
        target: UserRow;
        now: Date;
        common: Record<string, unknown>;
        refused: (code: LimitRefusal, current?: AccountLimitOverride | null, ceiling?: string) => AccountLimitResult;
        /** The override changed since the founder read it. */
        conflict: (current: AccountLimitOverride | null) => AccountLimitResult;
        finish: (result: AccountLimitResult) => Promise<AccountLimitResult>;
      },
    ) => Promise<AccountLimitResult>,
  ): Promise<AccountLimitResult> {
    return this.controls.founderStep(context, request.userId, async (tx, founder) => {
      const [clock] = await tx<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
      const now = clock!.at;
      const auditId = randomUUID();
      const common = {
        auditId,
        requestId: request.requestId,
        userId: request.userId,
        action: request.action,
        rail: request.rail,
        assetId: request.assetId,
        reason: request.reason,
        occurredAt: now.toISOString(),
      };
      const refused = (code: LimitRefusal, current: AccountLimitOverride | null = null, ceiling?: string) =>
        accountLimitResultSchema.parse({
          ...common,
          outcome: 'refused',
          changed: false,
          actorUserId: founder.actorId,
          code,
          current,
          ...(ceiling ? { ceiling } : {}),
        });
      const conflict = (current: AccountLimitOverride | null) =>
        accountLimitResultSchema.parse({
          ...common,
          outcome: 'conflict',
          changed: false,
          actorUserId: founder.actorId,
          code: 'restriction.version_conflict',
          current,
        });
      // A caller who is not a live founder is answered and leaves no row: the history is the founders' record.
      if (founder.refusal) return refused(founder.refusal);
      const hash = createHash('sha256')
        .update(JSON.stringify({ actorId: founder.actorId, input }))
        .digest('hex');
      const record = async (result: AccountLimitResult, stored: boolean) => {
        await tx`INSERT INTO account_limit_events (audit_id, request_id, actor_id, user_id, fingerprint, result, stored)
          VALUES (${auditId}, ${request.requestId}, ${founder.actorId}, ${request.userId}, ${hash}, ${tx.json(result as never)}, ${stored})`;
        return result;
      };
      const [previous] = await tx<
        Array<{ fingerprint: string; result: unknown }>
      >`SELECT fingerprint, result FROM account_limit_events WHERE request_id = ${request.requestId} AND stored`;
      if (previous)
        return previous.fingerprint === hash ? accountLimitResultSchema.parse(previous.result) : record(refused('request.conflict'), false);
      if (!founder.target) return record(refused('target.not_found'), true);
      return body(tx, {
        actorId: founder.actorId!,
        target: founder.target,
        now,
        common,
        refused,
        conflict,
        finish: (result) => record(result, true),
      });
    });
  }

  /**
   * Set (or replace) the override of one rail and asset. It names the version it read; it ends at `expiresAt`, which must
   * be after now and within the owner's longest lifetime. Above the ceiling it needs the other founder's approval.
   */
  async set(context: Context, raw: AccountLimitOverrideSetInput): Promise<AccountLimitResult> {
    const input = accountLimitOverrideSetInputSchema.parse(raw);
    input.requestId = input.requestId.toLowerCase();
    input.userId = input.userId.toLowerCase();
    input.expiresAt = new Date(input.expiresAt).toISOString();
    return this.step(
      context,
      { ...input, action: 'set' },
      input,
      async (tx, { actorId, target, now, common, refused, conflict, finish }) => {
        if (target.id === actorId) return finish(refused('identity.limit_self_forbidden'));
        if (target.archived_at !== null) return finish(refused('identity.account_archived'));
        if (target.status === 'closed') return finish(refused('identity.limit_account_closed'));
        const row = await this.row(tx, input.userId, input.rail, input.assetId);
        const current = row ? overrideOf(row, now) : null;
        const ceiling = this.ceilingOf(input.rail, input.assetId);
        if (!this.policy.configured || ceiling === null) return finish(refused('identity.limit_ceiling_unset', current));
        if ((current?.version ?? '0') !== input.expectedVersion) return finish(conflict(current));
        const expiresAt = new Date(input.expiresAt);
        if (expiresAt.getTime() <= now.getTime()) return finish(refused('identity.limit_expiry_past', current));
        if (expiresAt.getTime() > now.getTime() + Number(this.policy.maxLifetimeHours) * 3_600_000)
          return finish(refused('identity.limit_lifetime_exceeded', current));
        if (
          current?.status === 'active' &&
          sameFigure(current.perTx, input.perTx) &&
          sameFigure(current.rolling24h, input.rolling24h) &&
          current.expiresAt === input.expiresAt
        )
          return finish(refused('identity.limit_unchanged', current));
        const above = [input.perTx, input.rolling24h].some((figure) => figure !== null && limitAbove(figure, ceiling));
        let approverId: string | null = null;
        if (above) {
          if (!input.approvalId) return finish(refused('identity.limit_requires_approver', current, ceiling));
          const spent = await this.controls.spendFounderApproval(tx, {
            approvalId: input.approvalId,
            actionType: IDENTITY_LIMIT_CHANGE_ACTION_TYPE,
            payloadHash: identityLimitPayloadHash(input),
            targetId: input.userId,
            expectedVersion: input.expectedVersion,
            actorId,
            requestId: input.requestId,
            now,
          });
          if (spent.refusal)
            return finish(
              refused(spent.refusal === 'mismatch' ? 'identity.limit_approval_mismatch' : 'identity.limit_approval_consumed', current),
            );
          approverId = spent.approverId;
        }
        const version = (BigInt(current?.version ?? '0') + 1n).toString();
        await tx`INSERT INTO account_limit_overrides (user_id, rail, asset_id, version, per_tx, rolling_24h, expires_at, set_by,
            approved_by, approval_id, set_at, reason, cleared_by, cleared_at)
          VALUES (${input.userId}, ${input.rail}, ${input.assetId}, ${version}::bigint, ${input.perTx}, ${input.rolling24h},
            ${input.expiresAt}, ${actorId}, ${approverId}, ${approverId ? input.approvalId! : null}, ${now.toISOString()}, ${input.reason.trim()}, NULL, NULL)
          ON CONFLICT (user_id, rail, asset_id) DO UPDATE SET version = EXCLUDED.version, per_tx = EXCLUDED.per_tx,
            rolling_24h = EXCLUDED.rolling_24h, expires_at = EXCLUDED.expires_at, set_by = EXCLUDED.set_by,
            approved_by = EXCLUDED.approved_by, approval_id = EXCLUDED.approval_id, set_at = EXCLUDED.set_at,
            reason = EXCLUDED.reason, cleared_by = NULL, cleared_at = NULL`;
        const after = overrideOf((await this.row(tx, input.userId, input.rail, input.assetId))!, now);
        return finish(
          accountLimitResultSchema.parse({
            ...common,
            outcome: 'changed',
            changed: true,
            actorUserId: actorId,
            approverUserId: approverId,
            before: current,
            after,
          }),
        );
      },
    );
  }

  /** End an active override now; the base limit is back at once. An override that already ended is refused by name. */
  async clear(context: Context, raw: AccountLimitOverrideClearInput): Promise<AccountLimitResult> {
    const input = accountLimitOverrideClearInputSchema.parse(raw);
    input.requestId = input.requestId.toLowerCase();
    input.userId = input.userId.toLowerCase();
    return this.step(
      context,
      { ...input, action: 'clear' },
      input,
      async (tx, { actorId, target, now, common, refused, conflict, finish }) => {
        if (target.id === actorId) return finish(refused('identity.limit_self_forbidden'));
        if (target.archived_at !== null) return finish(refused('identity.account_archived'));
        const row = await this.row(tx, input.userId, input.rail, input.assetId);
        const current = row ? overrideOf(row, now) : null;
        if ((current?.version ?? '0') !== input.expectedVersion) return finish(conflict(current));
        if (!current || current.status === 'cleared') return finish(refused('identity.limit_override_not_found', current));
        if (current.status === 'expired') return finish(refused('identity.limit_override_expired', current));
        const version = (BigInt(current.version) + 1n).toString();
        await tx`UPDATE account_limit_overrides SET version = ${version}::bigint, cleared_by = ${actorId}, cleared_at = ${now.toISOString()}
          WHERE user_id = ${input.userId} AND rail = ${input.rail} AND asset_id = ${input.assetId}`;
        const after = overrideOf((await this.row(tx, input.userId, input.rail, input.assetId))!, now);
        return finish(
          accountLimitResultSchema.parse({
            ...common,
            outcome: 'changed',
            changed: true,
            actorUserId: actorId,
            approverUserId: null,
            before: current,
            after,
          }),
        );
      },
    );
  }

  /** The customer's overrides as they stand, with the owner policy; null when identity has no such customer. */
  async state(context: Context, raw: { userId: string }): Promise<AccountLimitsState | null> {
    const userId = accountLimitsLookupInputSchema.parse(raw).userId.toLowerCase();
    return this.controls.founderStep(context, userId, async (tx, founder) => {
      if (founder.refusal) throw new FounderControlError(founder.refusal, 'Live founder authority is required');
      if (!founder.target) return null;
      const [clock] = await tx<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
      const rows = await tx<OverrideRow[]>`SELECT user_id, rail, asset_id, version::text AS version, per_tx, rolling_24h, expires_at,
          set_by, approved_by, set_at, reason, cleared_by, cleared_at
        FROM account_limit_overrides WHERE user_id = ${userId} ORDER BY rail, asset_id LIMIT 100`;
      return accountLimitsStateSchema.parse({
        userId,
        overrides: rows.map((row) => overrideOf(row, clock!.at)),
        policy: this.policy,
        closed: founder.target.status === 'closed',
        archived: founder.target.archived_at !== null,
      });
    });
  }

  /** Every set and clear attempt, newest first. */
  async history(context: Context, raw: { userId: string; limit: number }): Promise<AccountLimitResult[]> {
    const input = accountLimitsHistoryInputSchema.parse(raw);
    const userId = input.userId.toLowerCase();
    return this.controls.founderStep(context, userId, async (tx, founder) => {
      if (founder.refusal) throw new FounderControlError(founder.refusal, 'Live founder authority is required');
      const rows = await tx<Array<{ result: unknown }>>`SELECT result FROM account_limit_events WHERE user_id = ${userId}
        ORDER BY created_at DESC, audit_id DESC LIMIT ${input.limit}`;
      return rows.map((row) => accountLimitResultSchema.parse(row.result));
    });
  }

  /**
   * The override in force now for one rail and asset, for the service that enforces the limit (service credentials are
   * checked by the route). `bad_query` for a user id, rail or asset that is not one identity knows the shape of;
   * `not_found` when identity has no such customer; `override: null` when none is in force (never set, expired, cleared, or
   * the account is closed), so the base limit applies. Expiry is judged on the database clock, the same clock that stored it.
   */
  async overrideInForce(userId: string, rail: string, assetId: string): Promise<AccountLimitOverrideRead | 'not_found' | 'bad_query'> {
    const parsed = z
      .object({ userId: z.string().guid(), rail: z.enum(ACCOUNT_LIMIT_RAILS), assetId: accountLimitAssetIdSchema })
      .safeParse({ userId: userId.toLowerCase(), rail, assetId });
    if (!parsed.success) return 'bad_query';
    const [user] = await this.sql<Array<{ status: string; archived_at: Date | null }>>`
      SELECT status, archived_at FROM users WHERE id = ${parsed.data.userId}`;
    if (!user) return 'not_found';
    const [row] =
      user.status === 'closed' || user.archived_at !== null
        ? []
        : await this.sql<Array<{ version: string; per_tx: string | null; rolling_24h: string | null; expires_at: Date }>>`
      SELECT version::text AS version, per_tx, rolling_24h, expires_at FROM account_limit_overrides
      WHERE user_id = ${parsed.data.userId} AND rail = ${parsed.data.rail} AND asset_id = ${parsed.data.assetId}
        AND cleared_at IS NULL AND expires_at > clock_timestamp()`;
    return accountLimitOverrideReadSchema.parse({
      ...parsed.data,
      override: row
        ? { version: row.version, perTx: row.per_tx, rolling24h: row.rolling_24h, expiresAt: row.expires_at.toISOString() }
        : null,
    });
  }
}
