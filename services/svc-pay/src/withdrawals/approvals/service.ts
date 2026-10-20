import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { BankApproverEligibilityPort } from '@intafaced/contracts';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { PayError } from '../../payment-service.js';
import type { UserMoneyService } from '../../user-money-service.js';
import { WithdrawalApprovalError } from './errors.js';
import type {
  ApprovalStatus,
  ListForTeamInput,
  ListInput,
  PolicyView,
  ProposeInput,
  RequestView,
  SetPolicyInput,
  SettleResult,
} from './schemas.js';

/**
 * Multi-approval for withdrawals (W-withdraw-11, wallet-withdraw-037). A withdrawal that policy says needs N approvers is
 * submitted as a REQUEST that freezes its terms (amount, asset, rail, destination, client reference). The request moves
 * nothing by itself. When N distinct eligible approvers have approved, the frozen terms run through the ordinary
 * `UserMoneyService.withdraw` under the same client reference, so the ledger keys are the ones a customer withdrawal would
 * have used. This file owns the request and its decisions, and nothing about balances.
 *
 * - POLICY is owner-set per (user, asset) and read from the latest event; none means the user has no policy and a request
 *   refuses `policy_unset`. Withdrawals stay direct until a policy is set and the amount (plus the same user's withdrawals in
 *   the window, so a split cannot slip under) reaches the threshold; then the direct door refuses `required`.
 * - HOLD is placed at submission only when the policy says so (`holdAtSubmit`). It is `UserMoneyService.withdraw` stopped
 *   after its hold, so the row stays `pending` with the hold booked, which is the state a crash already leaves and the state
 *   `cancelWithdrawal` gives back once. Without it, nothing is held and no rail is called until the approvals exist.
 * - ELIGIBILITY is svc-bank's (team roles); this service asks through a port and never reads the team tables. No answer, or
 *   no port, refuses: an unreachable team is never read as eligible. The initiator can never approve, and one approver counts
 *   once however often they approve (the decision row is keyed on request and approver).
 * - EXPIRY ends a pending request and gives back its hold once. A request that reached its approvals is never expired.
 * - CRASH between the last approval and the dispatch leaves the request `approved`; `approve` again or `settleDue` runs the
 *   same frozen terms under the same client reference and the same keys, so nothing is sent twice and nothing is stranded.
 */

export interface WithdrawalTerms {
  userId: string;
  assetId: string;
  amount: Amount;
  rail: string;
  destination: { kind: string; ref: string };
  clientRef: string;
}

/** What the approval flow needs from the withdrawal door. `approvalMoneyOf` adapts `UserMoneyService`. */
export interface WithdrawalApprovalMoney {
  /** Every refusal a fresh withdrawal would hit before a row exists. Posts nothing. */
  preflight(terms: WithdrawalTerms): Promise<void>;
  /** What the ledger says the user can withdraw now. */
  available(userId: string, assetId: string): Promise<Amount>;
  /** Claim and post the hold, then stop. Idempotent on the client reference. */
  hold(terms: WithdrawalTerms): Promise<void>;
  /** The ordinary withdrawal. Resumes a held row. */
  execute(terms: WithdrawalTerms): Promise<void>;
  /** Cancel a withdrawal that has no send attempt and give its hold back once. */
  release(userId: string, withdrawalId: string): Promise<void>;
}

export function approvalMoneyOf(money: UserMoneyService): WithdrawalApprovalMoney {
  return {
    preflight: async (t) => void (await money.preflightWithdrawal(t)),
    available: (userId, assetId) => money.availableBalance(userId, assetId),
    hold: async (t) => void (await money.withdraw(t, { stopAfterHold: true })),
    execute: async (t) => void (await money.withdraw(t)),
    release: async (userId, withdrawalId) => void (await money.cancelWithdrawal({ userId, withdrawalId })),
  };
}

export interface WithdrawalApprovalServiceDeps {
  readonly sql: Sql;
  readonly money: WithdrawalApprovalMoney;
  /** Absent: every approval refuses `eligibility_unwired`. */
  readonly eligibility?: BankApproverEligibilityPort;
  /** Injected for tests; production uses the wall clock. */
  readonly now?: () => Date;
}

interface RequestRow {
  id: string;
  user_id: string;
  client_ref: string;
  asset_id: string;
  amount: string;
  rail: string;
  destination: { kind: string; ref: string };
  team_account_id: string;
  required_approvals: number;
  hold_at_submit: boolean;
  status: ApprovalStatus;
  failure_code: string | null;
  expires_at: Date;
  created_at: Date;
  decided_at: Date | null;
}

export interface PolicyRow {
  user_id: string;
  asset_id: string;
  active: boolean;
  team_account_id: string;
  required_approvals: number;
  threshold: string;
  window_seconds: number;
  expiry_seconds: number;
  hold_at_submit: boolean;
  set_by: string;
  set_at: Date;
}

const COLUMNS = `id, user_id, client_ref, asset_id, amount::text AS amount, rail, destination, team_account_id, required_approvals,
  hold_at_submit, status, failure_code, expires_at, created_at, decided_at`;

/** A rail or ledger outcome nobody knows yet. The request stays `approved` and the same terms run again. */
const RETRYABLE = new Set(['pay.ledger_outcome_unknown', 'pay.rail_outcome_unknown']);
/** A release that finds the withdrawal already past cancelling has nothing left to give back. */
const NOTHING_TO_RELEASE = new Set(['pay.withdrawal_not_cancellable', 'pay.withdrawal_not_found']);

const terms = (r: RequestRow): WithdrawalTerms => ({
  userId: r.user_id,
  assetId: r.asset_id,
  amount: parseAmount(r.amount),
  rail: r.rail,
  destination: r.destination,
  clientRef: r.client_ref,
});

/** The key of the lock that orders a user's withdrawals of one asset against each other and against new requests. */
export const approvalLockKey = (userId: string, assetId: string): string => `pay.withdrawal_approval:${userId}:${assetId}`;

/** The latest policy event, active or not. Null when none was ever set. */
export async function latestPolicyRow(q: Sql, userId: string, assetId: string): Promise<PolicyRow | null> {
  const [row] = await q<PolicyRow[]>`
    SELECT user_id, asset_id, active, team_account_id, required_approvals, threshold::text AS threshold, window_seconds,
           expiry_seconds, hold_at_submit, set_by, set_at
      FROM pay.withdrawal_approval_policy_events
     WHERE user_id = ${userId} AND asset_id = ${assetId}
     ORDER BY seq DESC LIMIT 1`;
  return row ?? null;
}

/**
 * The policy that applies to this withdrawal, or null when it may go direct. Applies when a policy is active and this amount
 * plus the user's other withdrawals of the asset inside the window reaches the threshold. A request for the same client
 * reference is left out of the sum, so a retry never counts itself.
 */
export async function policyAppliesTo(
  q: Sql,
  now: Date,
  userId: string,
  assetId: string,
  amount: Amount,
  clientRef: string,
): Promise<PolicyRow | null> {
  const policy = await latestPolicyRow(q, userId, assetId);
  if (!policy || !policy.active) return null;
  const since = new Date(now.getTime() - policy.window_seconds * 1000);
  const [sum] = await q<Array<{ total: string }>>`
    SELECT COALESCE(SUM(amount), 0)::text AS total FROM (
      SELECT w.amount FROM pay.withdrawals w
       WHERE w.user_id = ${userId} AND w.asset_id = ${assetId} AND w.status <> 'failed'
         AND w.created_at > ${since} AND w.client_ref <> ${clientRef}
      UNION ALL
      SELECT r.amount FROM pay.withdrawal_approval_requests r
       WHERE r.user_id = ${userId} AND r.asset_id = ${assetId} AND r.status IN ('pending', 'approved')
         AND r.created_at > ${since} AND r.client_ref <> ${clientRef}
         AND NOT EXISTS (SELECT 1 FROM pay.withdrawals w WHERE w.user_id = r.user_id AND w.client_ref = r.client_ref)
    ) t`;
  return parseAmount(sum!.total) + amount >= parseAmount(policy.threshold) ? policy : null;
}

export class WithdrawalApprovalService {
  private readonly now: () => Date;
  constructor(private readonly deps: WithdrawalApprovalServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ── policy ────────────────────────────────────────────────────────────────

  async setPolicy(actor: string, input: SetPolicyInput): Promise<PolicyView> {
    const [row] = await this.deps.sql<PolicyRow[]>`
      INSERT INTO pay.withdrawal_approval_policy_events
        (user_id, asset_id, active, team_account_id, required_approvals, threshold, window_seconds, expiry_seconds, hold_at_submit, set_by)
      VALUES (${input.userId}, ${input.assetId}, ${input.active}, ${input.teamAccountId}, ${input.requiredApprovals},
              ${input.threshold}::numeric, ${input.windowSeconds}, ${input.expirySeconds}, ${input.holdAtSubmit}, ${actor})
      RETURNING user_id, asset_id, active, team_account_id, required_approvals, threshold::text AS threshold, window_seconds,
                expiry_seconds, hold_at_submit, set_by, set_at`;
    return policyView(row!);
  }

  /** The latest policy event, active or not. Null when none was ever set. */
  async policy(userId: string, assetId: string): Promise<PolicyView | null> {
    const row = await this.latestPolicy(this.deps.sql, userId, assetId);
    return row ? policyView(row) : null;
  }

  private latestPolicy(q: Sql, userId: string, assetId: string): Promise<PolicyRow | null> {
    return latestPolicyRow(q, userId, assetId);
  }

  /**
   * The policy that applies to this withdrawal, or null when it may go direct (see `policyAppliesTo`). Reads on `q`, so
   * `propose` can ask again inside the transaction that inserts the request.
   */
  private applicable(q: Sql, userId: string, assetId: string, amount: Amount, clientRef: string): Promise<PolicyRow | null> {
    return policyAppliesTo(q, this.now(), userId, assetId, amount, clientRef);
  }

  /**
   * The direct withdrawal door asks this first. It refuses `required` when the user's policy needs approvals for this
   * withdrawal, and when a request already exists for the client reference, whatever its status: a request is resumed only
   * by `approve` or `settleDue`, which send its frozen terms, never by the direct door, which would send the caller's.
   * A failed earlier attempt is a fresh ask and meets the policy again.
   */
  async assertDirectAllowed(input: { userId: string; assetId: string; amount: Amount; clientRef: string }): Promise<void> {
    const [request] = await this.deps.sql<Array<{ status: ApprovalStatus }>>`
      SELECT status FROM pay.withdrawal_approval_requests
       WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}`;
    if (request) {
      throw new WithdrawalApprovalError('withdrawal_approval.required', `this withdrawal is a request that is ${request.status}`, {
        status: request.status,
      });
    }
    const [existing] = await this.deps.sql<Array<{ status: string }>>`
      SELECT status FROM pay.withdrawals WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}`;
    if (existing && existing.status !== 'failed') return; // already admitted: a resume, not a fresh ask
    const policy = await this.applicable(this.deps.sql, input.userId, input.assetId, input.amount, input.clientRef);
    if (policy) {
      throw new WithdrawalApprovalError('withdrawal_approval.required', 'this withdrawal needs approvals; submit it as a request', {
        requiredApprovals: policy.required_approvals,
        teamAccountId: policy.team_account_id,
      });
    }
  }

  // ── submit ────────────────────────────────────────────────────────────────

  async propose(userId: string, input: ProposeInput): Promise<RequestView> {
    const amount = parseAmount(input.amount);
    if (amount <= 0n) throw new WithdrawalApprovalError('withdrawal_approval.amount_invalid', 'a withdrawal is a positive amount');
    const wanted = {
      userId,
      assetId: input.assetId,
      amount,
      rail: input.railId,
      destination: input.destination,
      clientRef: input.clientRef,
    };

    let request = await this.byRef(this.deps.sql, userId, input.clientRef);
    if (request) {
      this.assertSameTerms(request, wanted);
    } else {
      const policy = await this.latestPolicy(this.deps.sql, userId, input.assetId);
      if (!policy || !policy.active) {
        throw new WithdrawalApprovalError(
          'withdrawal_approval.policy_unset',
          'no approval policy is set for this asset; withdraw directly',
        );
      }
      if (!(await this.applicable(this.deps.sql, userId, input.assetId, amount, input.clientRef))) {
        throw new WithdrawalApprovalError(
          'withdrawal_approval.not_required',
          'this withdrawal is under the approval threshold; withdraw directly',
        );
      }
      // A withdrawal that could never run is refused here and not after its approvals.
      await this.deps.money.preflight(wanted);
      // A hold at submission can only be placed from funds that are there; say so now and not by leaving a request waiting.
      if (policy.hold_at_submit && (await this.deps.money.available(userId, input.assetId)) < amount) {
        throw new WithdrawalApprovalError('withdrawal_approval.insufficient_funds', 'the available balance does not cover this withdrawal');
      }
      const now = this.now();
      const inserted = await transaction(this.deps.sql, async (tx) => {
        // The same lock the direct door's guard takes in its claim: whichever commits second sees the other in the window sum.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${approvalLockKey(userId, input.assetId)}))`;
        if (!(await this.applicable(tx, userId, input.assetId, amount, input.clientRef))) {
          throw new WithdrawalApprovalError(
            'withdrawal_approval.not_required',
            'this withdrawal is under the approval threshold; withdraw directly',
          );
        }
        const rows = await tx<RequestRow[]>`
          INSERT INTO pay.withdrawal_approval_requests
            (user_id, client_ref, asset_id, amount, rail, destination, team_account_id, required_approvals, hold_at_submit, expires_at, created_at, updated_at)
          VALUES (${userId}, ${input.clientRef}, ${input.assetId}, ${input.amount}::numeric, ${input.railId}, ${tx.json(input.destination as never)},
                  ${policy.team_account_id}, ${policy.required_approvals}, ${policy.hold_at_submit},
                  ${new Date(now.getTime() + policy.expiry_seconds * 1000)}, ${now}, ${now})
          ON CONFLICT (user_id, client_ref) DO NOTHING
          RETURNING ${tx.unsafe(COLUMNS)}`;
        if (rows[0]) await this.event(tx, rows[0].id, 'proposed', userId, { amount: input.amount, assetId: input.assetId });
        return rows[0] ?? null;
      });
      request = inserted ?? (await this.byRef(this.deps.sql, userId, input.clientRef));
      if (!request) throw new WithdrawalApprovalError('withdrawal_approval.not_found', 'the request could not be read back');
      this.assertSameTerms(request, wanted);
    }

    // The hold is idempotent on the client reference, so a retry after a crash between the insert and the hold places it once.
    if (request.status === 'pending' && request.hold_at_submit) {
      try {
        await this.deps.money.hold(terms(request));
      } catch (error) {
        if (error instanceof PayError && !RETRYABLE.has(error.code)) {
          await this.finish(request.id, ['pending'], 'failed', userId, error.code);
        }
        throw error;
      }
    }
    return this.view(userId, (await this.byId(this.deps.sql, request.id))!);
  }

  // ── decide ────────────────────────────────────────────────────────────────

  async approve(approverId: string, requestId: string): Promise<RequestView> {
    const request = await this.load(requestId);
    await this.assertMayDecide(approverId, request);
    const decided = await transaction(this.deps.sql, async (tx) => {
      const row = await this.lock(tx, requestId);
      if (row.status === 'approved' || row.status === 'executed') return row; // past its approvals: only resume
      if (row.status !== 'pending') {
        throw new WithdrawalApprovalError('withdrawal_approval.not_pending', `this request is ${row.status}`, { status: row.status });
      }
      if (row.expires_at <= this.now()) throw new WithdrawalApprovalError('withdrawal_approval.expired', 'this request has expired');
      const added = await tx`
        INSERT INTO pay.withdrawal_approval_decisions (request_id, approver_id, decision, decided_at)
        VALUES (${requestId}, ${approverId}, 'approve', ${this.now()}) ON CONFLICT DO NOTHING RETURNING request_id`;
      if (added.length > 0) await this.event(tx, requestId, 'approved', approverId, {});
      const [count] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pay.withdrawal_approval_decisions WHERE request_id = ${requestId} AND decision = 'approve'`;
      if (count!.n < row.required_approvals) return row;
      const now = this.now();
      const [done] = await tx<RequestRow[]>`
        UPDATE pay.withdrawal_approval_requests SET status = 'approved', decided_at = ${now}, updated_at = ${now}
         WHERE id = ${requestId} AND status = 'pending' RETURNING ${tx.unsafe(COLUMNS)}`;
      await this.event(tx, requestId, 'quorum', approverId, { approvals: count!.n });
      return done!;
    });
    if (decided.status === 'approved') await this.execute(decided);
    return this.view(approverId, (await this.byId(this.deps.sql, requestId))!);
  }

  /** Any eligible approver may refuse, and the refusal ends the request: the hold, if any, goes back once. */
  async reject(approverId: string, requestId: string): Promise<RequestView> {
    const request = await this.load(requestId);
    await this.assertMayDecide(approverId, request);
    await transaction(this.deps.sql, async (tx) => {
      const row = await this.lock(tx, requestId);
      if (row.status === 'rejected') return;
      if (row.status !== 'pending') {
        throw new WithdrawalApprovalError('withdrawal_approval.not_pending', `this request is ${row.status}`, { status: row.status });
      }
      const now = this.now();
      await tx`
        INSERT INTO pay.withdrawal_approval_decisions (request_id, approver_id, decision, decided_at)
        VALUES (${requestId}, ${approverId}, 'reject', ${now}) ON CONFLICT DO NOTHING`;
      await tx`
        UPDATE pay.withdrawal_approval_requests SET status = 'rejected', decided_at = ${now}, updated_at = ${now} WHERE id = ${requestId}`;
      await this.event(tx, requestId, 'rejected', approverId, {});
    });
    await this.release((await this.byId(this.deps.sql, requestId))!);
    return this.view(approverId, (await this.byId(this.deps.sql, requestId))!);
  }

  /** The initiator withdraws their own request while it still waits. */
  async cancel(userId: string, requestId: string): Promise<RequestView> {
    const request = await this.load(requestId);
    if (request.user_id !== userId) throw notFound();
    await transaction(this.deps.sql, async (tx) => {
      const row = await this.lock(tx, requestId);
      if (row.status === 'canceled') return;
      if (row.status !== 'pending') {
        throw new WithdrawalApprovalError('withdrawal_approval.not_pending', `this request is ${row.status}`, { status: row.status });
      }
      const now = this.now();
      await tx`UPDATE pay.withdrawal_approval_requests SET status = 'canceled', decided_at = ${now}, updated_at = ${now} WHERE id = ${requestId}`;
      await this.event(tx, requestId, 'canceled', userId, {});
    });
    await this.release((await this.byId(this.deps.sql, requestId))!);
    return this.view(userId, (await this.byId(this.deps.sql, requestId))!);
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** The initiator, or an eligible approver of the request's team. Anyone else reads the same as no request. */
  async get(viewerId: string, requestId: string): Promise<RequestView> {
    const request = await this.byId(this.deps.sql, requestId);
    if (!request) throw notFound();
    if (request.user_id !== viewerId) {
      const answer = await this.deps.eligibility?.check({ accountId: request.team_account_id, userId: viewerId });
      if (answer?.state !== 'eligible') throw notFound();
    }
    return this.view(viewerId, request);
  }

  async list(userId: string, input: ListInput): Promise<RequestView[]> {
    const limit = this.limit(input.limit);
    const rows = await this.deps.sql<RequestRow[]>`
      SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.withdrawal_approval_requests
       WHERE user_id = ${userId}
         AND (${input.after ?? null}::uuid IS NULL
              OR (created_at, id) < (SELECT created_at, id FROM pay.withdrawal_approval_requests WHERE id = ${input.after ?? null}::uuid AND user_id = ${userId}))
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return Promise.all(rows.map((r) => this.view(userId, r)));
  }

  /** Requests waiting on a team, for an eligible approver of that team. */
  async listForTeam(viewerId: string, input: ListForTeamInput): Promise<RequestView[]> {
    const limit = this.limit(input.limit);
    await this.assertEligible(viewerId, input.teamAccountId);
    const rows = await this.deps.sql<RequestRow[]>`
      SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.withdrawal_approval_requests
       WHERE team_account_id = ${input.teamAccountId} AND user_id <> ${viewerId}
         AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
         AND (${input.after ?? null}::uuid IS NULL
              OR (created_at, id) < (SELECT created_at, id FROM pay.withdrawal_approval_requests WHERE id = ${input.after ?? null}::uuid AND team_account_id = ${input.teamAccountId}))
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return Promise.all(rows.map((r) => this.view(viewerId, r)));
  }

  // ── sweep ─────────────────────────────────────────────────────────────────

  /**
   * One pass of the due work, safe to repeat: expire pending requests past their time, finish any release a crash left
   * undone (a closed request whose withdrawal is still pending with its hold), and run any request that reached its
   * approvals but was never dispatched. A failure on one request is reported and does not stop the rest.
   */
  async settleDue(actor: string): Promise<SettleResult> {
    const result: SettleResult = { expired: 0, released: 0, resumed: 0, failures: [] };
    const note = (requestId: string, error: unknown) =>
      result.failures.push({
        requestId,
        code: error instanceof PayError || error instanceof WithdrawalApprovalError ? error.code : 'unexpected',
      });

    const due = await this.deps.sql<Array<{ id: string }>>`
      SELECT id FROM pay.withdrawal_approval_requests WHERE status = 'pending' AND expires_at <= ${this.now()} ORDER BY expires_at LIMIT 200`;
    for (const { id } of due) {
      try {
        const expired = await transaction(this.deps.sql, async (tx) => {
          const row = await this.lock(tx, id);
          if (row.status !== 'pending' || row.expires_at > this.now()) return false;
          const now = this.now();
          await tx`UPDATE pay.withdrawal_approval_requests SET status = 'expired', decided_at = ${now}, updated_at = ${now} WHERE id = ${id}`;
          await this.event(tx, id, 'expired', actor, {});
          return true;
        });
        if (expired) result.expired += 1;
      } catch (error) {
        note(id, error);
      }
    }

    const closed = await this.deps.sql<RequestRow[]>`
      SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.withdrawal_approval_requests r
       WHERE r.status IN ('rejected', 'expired', 'canceled', 'failed')
         AND EXISTS (SELECT 1 FROM pay.withdrawals w WHERE w.user_id = r.user_id AND w.client_ref = r.client_ref AND w.status = 'pending')
       ORDER BY r.updated_at LIMIT 200`;
    for (const row of closed) {
      try {
        if (await this.release(row)) result.released += 1;
      } catch (error) {
        note(row.id, error);
      }
    }

    const approved = await this.deps.sql<RequestRow[]>`
      SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.withdrawal_approval_requests WHERE status = 'approved' ORDER BY decided_at LIMIT 200`;
    for (const row of approved) {
      try {
        await this.execute(row);
        result.resumed += 1;
      } catch (error) {
        note(row.id, error);
      }
    }
    return result;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Run the frozen terms. An unknown ledger or rail outcome leaves the request `approved` so the same terms run again under
   * the same keys. A cancelled withdrawal ends the request `canceled`. Any other refusal ends it `failed` with the code and
   * gives back a hold the refusal left behind.
   */
  private async execute(request: RequestRow): Promise<void> {
    try {
      await this.deps.money.execute(terms(request));
    } catch (error) {
      if (!(error instanceof PayError) || RETRYABLE.has(error.code)) throw error;
      if (error.code === 'pay.withdrawal_canceled') {
        await this.finish(request.id, ['approved'], 'canceled', request.user_id, error.code);
      } else {
        await this.finish(request.id, ['approved'], 'failed', request.user_id, error.code);
        await this.release((await this.byId(this.deps.sql, request.id))!);
      }
      throw error;
    }
    await this.finish(request.id, ['approved'], 'executed', request.user_id, null);
  }

  /** Give back the hold of a closed request, if its withdrawal is still pending. True when something was released. */
  private async release(request: RequestRow): Promise<boolean> {
    const [withdrawal] = await this.deps.sql<Array<{ id: string; status: string }>>`
      SELECT id, status::text AS status FROM pay.withdrawals WHERE user_id = ${request.user_id} AND client_ref = ${request.client_ref}`;
    if (!withdrawal || withdrawal.status !== 'pending') return false;
    try {
      await this.deps.money.release(request.user_id, withdrawal.id);
    } catch (error) {
      if (error instanceof PayError && NOTHING_TO_RELEASE.has(error.code)) return false;
      throw error;
    }
    await this.event(this.deps.sql, request.id, 'released', 'system', { withdrawalId: withdrawal.id });
    return true;
  }

  private async finish(id: string, from: ApprovalStatus[], to: ApprovalStatus, actor: string, failureCode: string | null): Promise<void> {
    const now = this.now();
    await transaction(this.deps.sql, async (tx) => {
      const moved = await tx`
        UPDATE pay.withdrawal_approval_requests
           SET status = ${to}, failure_code = ${failureCode}, decided_at = COALESCE(decided_at, ${now}), updated_at = ${now}
         WHERE id = ${id} AND status = ANY(${from}) RETURNING id`;
      if (moved.length > 0) await this.event(tx, id, to, actor, failureCode ? { code: failureCode } : {});
    });
  }

  private async assertMayDecide(approverId: string, request: RequestRow): Promise<void> {
    if (approverId === request.user_id) {
      throw new WithdrawalApprovalError(
        'withdrawal_approval.initiator_cannot_approve',
        'the person who started a withdrawal cannot decide it',
      );
    }
    await this.assertEligible(approverId, request.team_account_id);
  }

  private async assertEligible(userId: string, teamAccountId: string): Promise<void> {
    if (!this.deps.eligibility) {
      throw new WithdrawalApprovalError(
        'withdrawal_approval.eligibility_unwired',
        'approver eligibility is not connected to the bank service',
      );
    }
    const answer = await this.deps.eligibility.check({ accountId: teamAccountId, userId });
    if (answer.state === 'unavailable') {
      throw new WithdrawalApprovalError(
        'withdrawal_approval.eligibility_unavailable',
        'the team could not be checked; nothing was counted',
      );
    }
    if (answer.state !== 'eligible') {
      throw new WithdrawalApprovalError('withdrawal_approval.approver_not_eligible', 'this person may not approve for the team', {
        state: answer.state,
      });
    }
  }

  private assertSameTerms(request: RequestRow, wanted: WithdrawalTerms): void {
    const same =
      request.asset_id === wanted.assetId &&
      parseAmount(request.amount) === wanted.amount &&
      request.rail === wanted.rail &&
      request.destination.kind === wanted.destination.kind &&
      request.destination.ref === wanted.destination.ref;
    if (!same) {
      throw new WithdrawalApprovalError(
        'withdrawal_approval.conflict',
        `client reference "${wanted.clientRef}" already names a request for ${request.amount} ${request.asset_id}`,
        { requestId: request.id },
      );
    }
  }

  private limit(limit: number | undefined): number {
    if (limit === undefined)
      throw new WithdrawalApprovalError('withdrawal_approval.list_limit_unset', 'pass a page size; there is no default');
    return limit;
  }

  private async load(requestId: string): Promise<RequestRow> {
    const row = await this.byId(this.deps.sql, requestId);
    if (!row) throw notFound();
    return row;
  }

  private async byId(q: Sql, id: string): Promise<RequestRow | null> {
    const [row] = await q<RequestRow[]>`SELECT ${q.unsafe(COLUMNS)} FROM pay.withdrawal_approval_requests WHERE id = ${id}`;
    return row ?? null;
  }

  private async byRef(q: Sql, userId: string, clientRef: string): Promise<RequestRow | null> {
    const [row] = await q<RequestRow[]>`
      SELECT ${q.unsafe(COLUMNS)} FROM pay.withdrawal_approval_requests WHERE user_id = ${userId} AND client_ref = ${clientRef}`;
    return row ?? null;
  }

  private async lock(tx: Sql, id: string): Promise<RequestRow> {
    const [row] = await tx<RequestRow[]>`SELECT ${tx.unsafe(COLUMNS)} FROM pay.withdrawal_approval_requests WHERE id = ${id} FOR UPDATE`;
    if (!row) throw notFound();
    return row;
  }

  private async event(q: Sql, requestId: string, kind: string, actor: string, detail: Record<string, unknown>): Promise<void> {
    await q`
      INSERT INTO pay.withdrawal_approval_events (request_id, kind, actor_id, detail)
      VALUES (${requestId}, ${kind}, ${actor}, ${q.json(detail as never)})`;
  }

  private async view(viewerId: string, r: RequestRow): Promise<RequestView> {
    const [counts] = await this.deps.sql<Array<{ n: number; mine: boolean }>>`
      SELECT count(*) FILTER (WHERE decision = 'approve')::int AS n,
             COALESCE(bool_or(approver_id = ${viewerId} AND decision = 'approve'), false) AS mine
        FROM pay.withdrawal_approval_decisions WHERE request_id = ${r.id}`;
    return {
      id: r.id,
      userId: r.user_id,
      assetId: r.asset_id,
      amount: formatAmount(parseAmount(r.amount)),
      rail: r.rail,
      destination: r.destination,
      clientRef: r.client_ref,
      teamAccountId: r.team_account_id,
      requiredApprovals: r.required_approvals,
      approvalCount: counts?.n ?? 0,
      approvedByMe: counts?.mine ?? false,
      holdAtSubmit: r.hold_at_submit,
      status: r.status,
      failureCode: r.failure_code,
      expiresAt: r.expires_at.toISOString(),
      createdAt: r.created_at.toISOString(),
      decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    };
  }
}

const notFound = () => new WithdrawalApprovalError('withdrawal_approval.not_found', 'no such withdrawal request');

function policyView(r: PolicyRow): PolicyView {
  return {
    userId: r.user_id,
    assetId: r.asset_id,
    active: r.active,
    teamAccountId: r.team_account_id,
    requiredApprovals: r.required_approvals,
    threshold: r.threshold,
    windowSeconds: r.window_seconds,
    expirySeconds: r.expiry_seconds,
    holdAtSubmit: r.hold_at_submit,
    setBy: r.set_by,
    setAt: r.set_at.toISOString(),
  };
}
