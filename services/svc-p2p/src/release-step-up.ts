/**
 * P-trade-orders-07 and -16: a release is confirmed with a fresh passkey or authenticator code.
 *
 * The seller proves a factor at identity (`stepUp.begin` / `stepUp.complete`) for the order whose escrow goes to the
 * buyer: scope `p2p.step_up.trades.confirmReceived`, field tradeId. The order's coin, amount and buyer are fixed at take,
 * so the order id names the whole release. Identity mints a single-use same-person approval bound to the user and the
 * session that proved it; svc-p2p recomputes the hash, consumes the approval once and records it here. That session may
 * then release its other orders for ten minutes (the D-145 window, as for takes) without another confirmation; any other
 * session, and any API key, cannot. A take's confirmation never covers a release: each has its own record.
 *
 * Fails closed: identity unwired or unreachable (`p2p.step_up_unverifiable`), a spent, foreign, expired or mismatched
 * approval, a window that has ended, or no confirmation at all each refuse before anything is decided.
 */
import { ACTION_APPROVAL_CONSUME_FAILED, customerStepUpPayloadHash, type ActionApproval } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';
import { TakeStepUpError, type TakeStepUpCaller } from './take-step-up.js';

export const RELEASE_STEP_UP_SCOPE = 'p2p.step_up.trades.confirmReceived' as const;
/** How long one confirmation covers further releases in the same session: the same ten minutes as a take. */
export const RELEASE_STEP_UP_WINDOW_SECONDS = 600;

export interface ReleaseStepUp {
  /** Refuses unless this release carries a valid confirmation, or this session confirmed one in the last ten minutes. */
  assertConfirmed(caller: TakeStepUpCaller, tradeId: string, approvalId: string | undefined): Promise<void>;
  /** Until when this session's releases need no new confirmation, or null when the next one does. */
  window(caller: TakeStepUpCaller): Promise<{ readonly confirmedUntil: Date | null }>;
}

/** The hash identity minted the approval over: the seller and the order. */
export function releaseStepUpPayloadHash(userId: string, tradeId: string): string {
  return customerStepUpPayloadHash(RELEASE_STEP_UP_SCOPE, { actor: userId, tradeId });
}

const refuseRequired = (why: string): never => {
  throw new TakeStepUpError(`auth.step_up_required: ${why}`, 'auth.step_up_required');
};
const refuseFailed = (why: string): never => {
  throw new TakeStepUpError(`auth.step_up_failed: ${why}`, 'auth.step_up_failed');
};

type UseRow = { user_id: string; session_id: string; trade_id: string; payload_hash: string; live: boolean };

export function createReleaseStepUp(deps: { readonly sql: Sql; readonly approvals: ActionApprovalConsumer }): ReleaseStepUp {
  const { sql, approvals } = deps;

  function sessionOf(caller: TakeStepUpCaller): string {
    if (caller.viaApiKey) refuseRequired('an API key cannot release an order; release it from a signed-in session');
    const sessionId = caller.sessionId?.trim() ?? '';
    if (!sessionId) refuseRequired('a release is confirmed in a signed-in session');
    return sessionId;
  }

  /** This session's latest release confirmation: none, or its end and whether that is still ahead (the database clock decides). */
  async function latest(userId: string, sessionId: string): Promise<{ readonly until: Date; readonly live: boolean } | null> {
    const [row] = await sql<{ until: Date | null; live: boolean | null }[]>`
      SELECT max(expires_at) AS until, max(expires_at) > now() AS live
        FROM p2p.release_step_ups
       WHERE user_id = ${userId} AND session_id = ${sessionId}
    `;
    if (!row?.until) return null;
    return { until: new Date(row.until), live: row.live === true };
  }

  async function consume(caller: TakeStepUpCaller, sessionId: string, tradeId: string, approvalId: string) {
    const payloadHash = releaseStepUpPayloadHash(caller.userId, tradeId);
    // A retry of this release with this approval, inside its window: its row says so, and identity is not asked again.
    const [used] = await sql<UseRow[]>`
      SELECT user_id, session_id, trade_id::text AS trade_id, payload_hash, expires_at > now() AS live
        FROM p2p.release_step_ups WHERE approval_id = ${approvalId}
    `;
    if (used) {
      if (
        used.user_id === caller.userId &&
        used.session_id === sessionId &&
        used.trade_id === tradeId.toLowerCase() &&
        used.payload_hash === payloadHash &&
        used.live
      ) {
        return;
      }
      refuseFailed('that confirmation was already used; confirm this release again');
    }
    let consumed: ActionApproval;
    try {
      consumed = await approvals.consume({
        approvalId,
        operationId: approvalId,
        payloadHash,
        targetService: 'svc-p2p',
        targetId: RELEASE_STEP_UP_SCOPE,
        expectedVersion: '1',
        principalUserId: caller.userId,
        principalSessionId: sessionId,
        // A lost reply between identity's consume and the row below: the same release asks again and identity replays.
        requestId: `p2p:release-step-up:${tradeId}`,
        consumerPrincipalId: caller.userId,
      });
    } catch (err) {
      // Identity answered and refused (spent, expired, foreign or mismatched): the person confirms again.
      if (err instanceof ActionApprovalConsumeError && err.code === ACTION_APPROVAL_CONSUME_FAILED) {
        return refuseFailed('the confirmation could not be used for this release; confirm it again');
      }
      // Unwired or no answer: a new confirmation would fail the same way.
      throw new TakeStepUpError(
        'p2p.step_up_unverifiable: the confirmation could not be checked; nothing was released',
        'p2p.step_up_unverifiable',
      );
    }
    if (
      consumed.kind !== 'same_person' ||
      consumed.status !== 'CONSUMED' ||
      consumed.requesterId !== caller.userId ||
      consumed.approverId !== caller.userId ||
      consumed.targetService !== 'svc-p2p' ||
      consumed.targetId !== RELEASE_STEP_UP_SCOPE
    ) {
      refuseFailed('the confirmation is not this person’s confirmation of this release');
    }
    await sql`
      INSERT INTO p2p.release_step_ups (approval_id, user_id, session_id, trade_id, payload_hash, confirmed_at, expires_at)
      VALUES (${approvalId}, ${caller.userId}, ${sessionId}, ${tradeId}, ${payloadHash}, now(),
              now() + make_interval(secs => ${RELEASE_STEP_UP_WINDOW_SECONDS}))
      ON CONFLICT (approval_id) DO NOTHING
    `;
  }

  return {
    async assertConfirmed(caller, tradeId, approvalId) {
      const sessionId = sessionOf(caller);
      const id = approvalId?.trim() ?? '';
      if (id) return consume(caller, sessionId, tradeId, id);
      const last = await latest(caller.userId, sessionId);
      if (last === null) return refuseRequired('confirm this release with your authenticator code or passkey');
      if (!last.live) {
        throw new TakeStepUpError(
          'auth.step_up_expired: the last confirmation has ended; confirm this release again',
          'auth.step_up_expired',
        );
      }
    },
    async window(caller) {
      const sessionId = sessionOf(caller);
      const last = await latest(caller.userId, sessionId);
      return { confirmedUntil: last?.live ? last.until : null };
    },
  };
}

/** No approval consumer and no database: every release refuses, so a missing wire never reads as "no confirmation needed". */
export function unwiredReleaseStepUp(): ReleaseStepUp {
  return {
    async assertConfirmed() {
      throw new TakeStepUpError(
        'p2p.step_up_unverifiable: release confirmation is not wired in this deployment',
        'p2p.step_up_unverifiable',
      );
    },
    async window() {
      return { confirmedUntil: null };
    },
  };
}
