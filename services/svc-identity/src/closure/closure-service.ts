/**
 * Account closure. Request, cooling-off, cancel, then a job finalises.
 *
 * Closing is not erasure. This service does not call p2p data.erase and does
 * not remove users, profiles, ledger rows, trade rows, or p2p rows.
 * Reopening is an operator decision outside this job.
 */
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { customerStepUpPayloadHash } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ActionApprovalError } from '../auth/action-approval-service.js';
import { userCopy } from '../user-copy.js';
import type { ClosureBalance, ClosureBlocker, ClosureCheckResult } from './closure-client.js';

export const CLOSE_SCOPE = 'identity.step_up.close_account';
export const CLOSE_LIMIT_MAX = 200;
const DAY_MS = 86_400_000;

export type ClosureStatus = 'requested' | 'cancelled' | 'blocked' | 'closed';

export type ClosureCode =
  | 'identity.close_disabled'
  | 'identity.close_cooling_off_unset'
  | 'identity.close_account_not_active'
  | 'identity.close_founder_forbidden'
  | 'identity.close_restricted'
  | 'identity.close_delegated'
  | 'identity.close_blocked'
  | 'identity.close_check_unavailable'
  | 'identity.close_nothing_open'
  | 'identity.step_up_required'
  | 'identity.step_up_expired'
  | 'identity.step_up_used'
  | 'identity.step_up_not_yours'
  | 'identity.step_up_target'
  | 'identity.close_finalize_limit_unset';

export class ClosureError extends Error {
  readonly blockers: readonly ClosureBlocker[];
  readonly balances: readonly ClosureBalance[];
  constructor(
    readonly code: ClosureCode,
    detail?: { blockers?: readonly ClosureBlocker[]; balances?: readonly ClosureBalance[] },
  ) {
    super(userCopy(code));
    this.name = 'ClosureError';
    this.blockers = detail?.blockers ?? [];
    this.balances = detail?.balances ?? [];
  }
}

export type ClosureView = {
  id: string;
  status: ClosureStatus;
  requestedAt: string;
  effectiveAt: string;
  finalizedAt: string | null;
  clientRequestId: string;
  blockers: ClosureBlocker[];
};

export type ClosureChecker = {
  check(input: { userId: string; subAccountIds: readonly string[] }): Promise<ClosureCheckResult>;
};

export type ApprovalConsumer = {
  consume(callerService: string, input: ActionApprovalConsumeInput): Promise<unknown>;
};

type Row = {
  id: string;
  user_id: string;
  status: ClosureStatus;
  requested_at: Date;
  effective_at: Date;
  finalized_at: Date | null;
  blockers: unknown;
  client_request_id: string;
};

export type ClosureDeps = {
  sql: Sql;
  approvals: ApprovalConsumer;
  enabled: boolean;
  coolingOffDays: number | undefined;
  founderUserIds: readonly string[];
  bank: ClosureChecker;
  trade: ClosureChecker;
  p2p: ClosureChecker;
  now: () => Date;
};

function postgresCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function publishedCoolingOffDays(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 90) return undefined;
  return value;
}

export function publishedFinalizeLimit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > CLOSE_LIMIT_MAX) return null;
  return value;
}

function blockersOf(value: unknown): ClosureBlocker[] {
  if (!Array.isArray(value)) return [];
  const out: ClosureBlocker[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { code?: unknown; count?: unknown };
    if (typeof row.code !== 'string') continue;
    if (typeof row.count !== 'number' || !Number.isInteger(row.count)) continue;
    out.push({ code: row.code, count: row.count });
  }
  return out;
}

function viewOf(row: Row): ClosureView {
  return {
    id: row.id,
    status: row.status,
    requestedAt: row.requested_at.toISOString(),
    effectiveAt: row.effective_at.toISOString(),
    finalizedAt: row.finalized_at ? row.finalized_at.toISOString() : null,
    clientRequestId: row.client_request_id,
    blockers: blockersOf(row.blockers),
  };
}

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class AccountClosureService {
  constructor(private readonly deps: ClosureDeps) {}

  async request(input: {
    userId: string;
    sessionId: string;
    apiKey: boolean;
    subAccount: boolean;
    stepUpApprovalId: string;
    clientRequestId: string;
  }): Promise<ClosureView> {
    this.assertSession(input);
    this.assertEnabled();
    if (!CLIENT_ID.test(input.clientRequestId)) throw new ClosureError('identity.step_up_target');
    const existing = await this.findReplay(input.userId, input.clientRequestId);
    if (existing) return viewOf(existing);
    await this.assertAccountMayClose(input.userId);
    await this.consume(input, 'request', input.clientRequestId);
    const checks = await this.checksFor(input.userId);
    if (!checks.ok) throw new ClosureError('identity.close_check_unavailable');
    if (checks.blockers.length > 0) {
      throw new ClosureError('identity.close_blocked', { blockers: checks.blockers, balances: checks.balances });
    }
    const now = this.deps.now();
    const days = publishedCoolingOffDays(this.deps.coolingOffDays);
    if (days === undefined) throw new ClosureError('identity.close_cooling_off_unset');
    const effective = new Date(now.getTime() + days * DAY_MS);
    try {
      const rows = await this.deps.sql<Row[]>`
        INSERT INTO account_closures (user_id, status, requested_at, effective_at, blockers, client_request_id)
        VALUES (${input.userId}, ${'requested'}, ${now}, ${effective}, ${this.deps.sql.json([])}, ${input.clientRequestId})
        RETURNING id, user_id, status, requested_at, effective_at, finalized_at, blockers, client_request_id
      `;
      return viewOf(rows[0]!);
    } catch (err) {
      if (postgresCode(err) !== '23505') throw err;
      const replay = await this.findReplay(input.userId, input.clientRequestId);
      if (replay) return viewOf(replay);
      throw err;
    }
  }

  async cancel(input: {
    userId: string;
    sessionId: string;
    apiKey: boolean;
    subAccount: boolean;
    stepUpApprovalId: string;
  }): Promise<ClosureView> {
    this.assertSession(input);
    this.assertEnabled();
    const open = await this.openRow(input.userId);
    if (!open) throw new ClosureError('identity.close_nothing_open');
    await this.consume(input, 'cancel', open.client_request_id);
    const now = this.deps.now();
    const rows = await this.deps.sql<Row[]>`
      UPDATE account_closures
      SET status = 'cancelled', finalized_at = ${now}
      WHERE id = ${open.id} AND user_id = ${input.userId} AND status = 'requested'
      RETURNING id, user_id, status, requested_at, effective_at, finalized_at, blockers, client_request_id
    `;
    if (rows[0]) return viewOf(rows[0]);
    const again = await this.deps.sql<Row[]>`
      SELECT id, user_id, status, requested_at, effective_at, finalized_at, blockers, client_request_id
      FROM account_closures WHERE id = ${open.id} AND user_id = ${input.userId}
    `;
    if (again[0]) return viewOf(again[0]);
    throw new ClosureError('identity.close_nothing_open');
  }

  /**
   * What still stands in the way, read now: the same checks `request` runs, without spending a step-up or writing anything.
   * An unreadable money service refuses (`close_check_unavailable`), never an empty list.
   */
  async check(input: {
    userId: string;
    apiKey: boolean;
    subAccount: boolean;
  }): Promise<{ blockers: ClosureBlocker[]; balances: ClosureBalance[] }> {
    this.assertSession(input);
    this.assertEnabled();
    await this.assertAccountMayClose(input.userId);
    const checks = await this.checksFor(input.userId);
    if (!checks.ok) throw new ClosureError('identity.close_check_unavailable');
    return { blockers: checks.blockers, balances: checks.balances };
  }

  async status(userId: string): Promise<ClosureView | null> {
    const rows = await this.deps.sql<Row[]>`
      SELECT id, user_id, status, requested_at, effective_at, finalized_at, blockers, client_request_id
      FROM account_closures WHERE user_id = ${userId}
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    // Staff can reopen a customer-closed account (J-ops-console-04 #7). The finished closure stays as history, but it is
    // not the account's state once the account is open again.
    if (row.status === 'closed') {
      const users = await this.deps.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId}`;
      if (users[0]?.status !== 'closed') return null;
    }
    return viewOf(row);
  }

  async finalize(limit: number): Promise<{ closed: number; blocked: number }> {
    const bounded = publishedFinalizeLimit(limit);
    if (bounded === null) throw new ClosureError('identity.close_finalize_limit_unset');
    const now = this.deps.now();
    const due = await this.deps.sql<Array<{ id: string }>>`
      SELECT id FROM account_closures
      WHERE status = 'requested' AND effective_at <= ${now}
      ORDER BY effective_at, id
      LIMIT ${bounded}
    `;
    let closed = 0;
    let blocked = 0;
    for (const candidate of due) {
      const outcome = await this.finalizeOne(candidate.id, now);
      if (outcome === 'closed') closed += 1;
      if (outcome === 'blocked') blocked += 1;
    }
    return { closed, blocked };
  }

  private async finalizeOne(id: string, now: Date): Promise<'closed' | 'blocked' | 'skipped'> {
    return this.deps.sql.begin(async (tx) => {
      const locked = await tx<Array<{ id: string; user_id: string }>>`
        SELECT id, user_id FROM account_closures
        WHERE id = ${id} AND status = 'requested'
        FOR UPDATE SKIP LOCKED
      `;
      const row = locked[0];
      if (!row) return 'skipped' as const;
      const users = await tx<Array<{ status: string }>>`
        SELECT status FROM users WHERE id = ${row.user_id} FOR UPDATE
      `;
      const status = users[0]?.status;
      if (status !== 'active') {
        await tx`
          UPDATE account_closures
          SET status = 'blocked',
              blockers = ${tx.json([{ code: 'identity.close_account_not_active', count: 1 }])},
              finalized_at = ${now}
          WHERE id = ${row.id}
        `;
        return 'blocked' as const;
      }
      const subs = await tx<Array<{ id: string }>>`
        SELECT id::text AS id FROM sub_accounts WHERE parent_user_id = ${row.user_id}
      `;
      const checks = await this.runChecks(
        row.user_id,
        subs.map((item) => item.id),
      );
      if (!checks.ok || checks.blockers.length > 0) {
        await tx`
          UPDATE account_closures
          SET status = 'blocked', blockers = ${tx.json(checks.ok ? checks.blockers : [{ code: 'identity.close_check_unavailable', count: 1 }])}, finalized_at = ${now}
          WHERE id = ${row.id}
        `;
        return 'blocked' as const;
      }
      await tx`UPDATE users SET status = 'closed' WHERE id = ${row.user_id} AND status = 'active'`;
      await tx`UPDATE sessions SET revoked = true WHERE user_id = ${row.user_id} AND revoked = false`;
      await tx`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'account_closed' WHERE user_id = ${row.user_id} AND revoked = false`;
      await tx`
        UPDATE account_closures
        SET status = 'closed', blockers = ${tx.json([])}, finalized_at = ${now}
        WHERE id = ${row.id}
      `;
      return 'closed' as const;
    });
  }

  private assertSession(input: { apiKey: boolean; subAccount: boolean }): void {
    if (input.apiKey || input.subAccount) throw new ClosureError('identity.close_delegated');
  }

  private assertEnabled(): void {
    if (!this.deps.enabled) throw new ClosureError('identity.close_disabled');
    if (publishedCoolingOffDays(this.deps.coolingOffDays) === undefined) throw new ClosureError('identity.close_cooling_off_unset');
  }

  private async assertAccountMayClose(userId: string): Promise<void> {
    const users = await this.deps.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId}`;
    const status = users[0]?.status;
    if (status !== 'active') throw new ClosureError('identity.close_account_not_active');
    const founders = new Set(this.deps.founderUserIds.map((id) => id.toLowerCase()));
    if (founders.has(userId.toLowerCase())) throw new ClosureError('identity.close_founder_forbidden');
    const restricted = await this.deps.sql<Array<{ restricted: boolean }>>`
      SELECT restricted FROM trading_restrictions WHERE user_id = ${userId} AND restricted = true
    `;
    if (restricted[0]?.restricted) throw new ClosureError('identity.close_restricted');
  }

  private async findReplay(userId: string, clientRequestId: string): Promise<Row | undefined> {
    const rows = await this.deps.sql<Row[]>`
      SELECT id, user_id, status, requested_at, effective_at, finalized_at, blockers, client_request_id
      FROM account_closures
      WHERE user_id = ${userId} AND (status = 'requested' OR client_request_id = ${clientRequestId})
      ORDER BY CASE WHEN status = 'requested' THEN 0 ELSE 1 END, requested_at DESC
      LIMIT 1
    `;
    return rows[0];
  }

  private async openRow(userId: string): Promise<Row | undefined> {
    const rows = await this.deps.sql<Row[]>`
      SELECT id, user_id, status, requested_at, effective_at, finalized_at, blockers, client_request_id
      FROM account_closures
      WHERE user_id = ${userId} AND status = 'requested'
      LIMIT 1
    `;
    return rows[0];
  }

  private async consume(
    input: { userId: string; sessionId: string; stepUpApprovalId: string },
    intent: 'request' | 'cancel',
    clientRequestId: string,
  ): Promise<void> {
    try {
      await this.deps.approvals.consume('svc-identity', {
        approvalId: input.stepUpApprovalId,
        operationId: input.stepUpApprovalId,
        payloadHash: customerStepUpPayloadHash(CLOSE_SCOPE, {
          actor: input.userId,
          intent,
          clientRequestId,
        }),
        targetService: 'svc-identity',
        targetId: CLOSE_SCOPE,
        expectedVersion: '1',
        principalUserId: input.userId,
        principalSessionId: input.sessionId,
      });
    } catch (err) {
      if (err instanceof ActionApprovalError && err.code === 'action_approval.payload_mismatch') {
        const rows = await this.deps.sql<Array<{ requester_id: string }>>`
          SELECT requester_id FROM action_approvals WHERE approval_id = ${input.stepUpApprovalId}
        `;
        if (rows[0] && rows[0].requester_id !== input.userId) throw new ClosureError('identity.step_up_not_yours');
      }
      if (err instanceof ActionApprovalError) {
        const code =
          err.code === 'action_approval.expired'
            ? 'identity.step_up_expired'
            : err.code === 'action_approval.consumed'
              ? 'identity.step_up_used'
              : err.code === 'action_approval.not_requester'
                ? 'identity.step_up_not_yours'
                : err.code === 'action_approval.payload_mismatch' || err.code === 'action_approval.target_mismatch'
                  ? 'identity.step_up_target'
                  : 'identity.step_up_required';
        throw new ClosureError(code);
      }
      throw err;
    }
  }

  private async checksFor(userId: string): Promise<{ ok: true; blockers: ClosureBlocker[]; balances: ClosureBalance[] } | { ok: false }> {
    const subs = await this.deps.sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM sub_accounts WHERE parent_user_id = ${userId}
    `;
    return this.runChecks(
      userId,
      subs.map((row) => row.id),
    );
  }

  private async runChecks(
    userId: string,
    subAccountIds: string[],
  ): Promise<{ ok: true; blockers: ClosureBlocker[]; balances: ClosureBalance[] } | { ok: false }> {
    const input = { userId, subAccountIds };
    const [bank, trade, p2p] = await Promise.all([this.deps.bank.check(input), this.deps.trade.check(input), this.deps.p2p.check(input)]);
    if (!bank.ok || !trade.ok || !p2p.ok) return { ok: false };
    const blockers = [...bank.blockers, ...trade.blockers, ...p2p.blockers];
    return { ok: true, blockers: [...blockers], balances: [...bank.balances] };
  }
}
