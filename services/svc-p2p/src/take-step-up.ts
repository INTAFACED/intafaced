/**
 * P-trade-orders-07: a take is confirmed with a fresh passkey or authenticator code.
 *
 * The person proves a factor at identity (`stepUp.begin` / `stepUp.complete`) for the exact take under review: scope
 * `p2p.step_up.trades.take`, fields offerId, amount, method and the held quote when there is one. Identity
 * mints a single-use same-person approval bound to the user and the session that proved it. svc-p2p recomputes the
 * hash from the take's own input, consumes the approval once and records it here. The same session may then take
 * again for ten minutes (the D-145 window) without another confirmation; any other session, and any API key, cannot.
 * Identity starts a new session id at every token refresh, so the window also ends at the session's next refresh.
 *
 * Fails closed: identity unwired or unreachable (`p2p.step_up_unverifiable`), a spent, foreign, expired or mismatched
 * approval, a window that has ended, or no confirmation at all each refuse before anything is reserved or locked.
 * The confirmation is spent before the take's own checks run, so a take refused after it still opens the window:
 * the window says the person proved a factor here, not that an order was placed.
 */
import { ACTION_APPROVAL_CONSUME_FAILED, customerStepUpPayloadHash, type ActionApproval } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';

export const TAKE_STEP_UP_SCOPE = 'p2p.step_up.trades.take' as const;
/** How long one confirmation covers further takes in the same session. Fixed, like identity's own step-up lifetimes. */
export const TAKE_STEP_UP_WINDOW_SECONDS = 600;

export type TakeStepUpCode =
  | 'auth.step_up_required'
  | 'auth.step_up_expired'
  | 'auth.step_up_failed'
  /** Identity is unwired or could not answer: nothing about the confirmation was decided, so do not ask for a new one. */
  | 'p2p.step_up_unverifiable';

export class TakeStepUpError extends Error {
  constructor(
    message: string,
    readonly code: TakeStepUpCode,
  ) {
    super(message);
    this.name = 'TakeStepUpError';
  }
}

/** The take as `trades.take` received it: the strings the customer's confirmation was hashed over. */
export type TakeStepUpFields = {
  readonly tradeId: string;
  readonly offerId: string;
  readonly amount: string;
  readonly method: string;
  readonly quoteId?: string;
};

export type TakeStepUpCaller = {
  readonly userId: string;
  /** The signed-in session (`sid`). Absent means no session to confirm in. */
  readonly sessionId: string | undefined;
  /** True when an API key minted the token: a key never confirms a take. */
  readonly viaApiKey: boolean;
};

export interface TakeStepUp {
  /** Refuses unless this take carries a valid confirmation, or this session confirmed one in the last ten minutes. */
  assertConfirmed(caller: TakeStepUpCaller, take: TakeStepUpFields, approvalId: string | undefined): Promise<void>;
  /** Until when this session's takes need no new confirmation, or null when the next one does. */
  window(caller: TakeStepUpCaller): Promise<{ readonly confirmedUntil: Date | null }>;
}

/**
 * The hash identity minted the approval over: actor plus the reviewed ad, amount and method, the held quote only when
 * sent. The order id is the take's idempotency key, not part of the review: it binds through the use row instead.
 */
export function takeStepUpPayloadHash(userId: string, take: TakeStepUpFields): string {
  return customerStepUpPayloadHash(TAKE_STEP_UP_SCOPE, {
    actor: userId,
    offerId: take.offerId,
    amount: take.amount,
    method: take.method,
    ...(take.quoteId === undefined ? {} : { quoteId: take.quoteId }),
  });
}

const refuseRequired = (why: string): never => {
  throw new TakeStepUpError(`auth.step_up_required: ${why}`, 'auth.step_up_required');
};
const refuseFailed = (why: string): never => {
  throw new TakeStepUpError(`auth.step_up_failed: ${why}`, 'auth.step_up_failed');
};

type UseRow = { user_id: string; session_id: string; trade_id: string; payload_hash: string; live: boolean };

export function createTakeStepUp(deps: { readonly sql: Sql; readonly approvals: ActionApprovalConsumer }): TakeStepUp {
  const { sql, approvals } = deps;

  function sessionOf(caller: TakeStepUpCaller): string {
    if (caller.viaApiKey) refuseRequired('an API key cannot confirm a take; place it from a signed-in session');
    const sessionId = caller.sessionId?.trim() ?? '';
    if (!sessionId) refuseRequired('a take is confirmed in a signed-in session');
    return sessionId;
  }

  /** This session's latest confirmation: none, or its end and whether that is still ahead (the database clock decides). */
  async function latest(userId: string, sessionId: string): Promise<{ readonly until: Date; readonly live: boolean } | null> {
    const [row] = await sql<{ until: Date | null; live: boolean | null }[]>`
      SELECT max(expires_at) AS until, max(expires_at) > now() AS live
        FROM p2p.take_step_ups
       WHERE user_id = ${userId} AND session_id = ${sessionId}
    `;
    if (!row?.until) return null;
    return { until: new Date(row.until), live: row.live === true };
  }

  async function consume(caller: TakeStepUpCaller, sessionId: string, take: TakeStepUpFields, approvalId: string) {
    const payloadHash = takeStepUpPayloadHash(caller.userId, take);
    // A retry of this exact take with this approval, inside its window: its row says so, and identity is not asked
    // again. The same order id with other terms, or after the window, is not a retry.
    const [used] = await sql<UseRow[]>`
      SELECT user_id, session_id, trade_id, payload_hash, expires_at > now() AS live
        FROM p2p.take_step_ups WHERE approval_id = ${approvalId}
    `;
    if (used) {
      if (
        used.user_id === caller.userId &&
        used.session_id === sessionId &&
        used.trade_id === take.tradeId &&
        used.payload_hash === payloadHash &&
        used.live
      ) {
        return;
      }
      refuseFailed('that confirmation was already used; confirm this order again');
    }
    let consumed: ActionApproval;
    try {
      consumed = await approvals.consume({
        approvalId,
        operationId: approvalId,
        payloadHash,
        targetService: 'svc-p2p',
        targetId: TAKE_STEP_UP_SCOPE,
        expectedVersion: '1',
        principalUserId: caller.userId,
        principalSessionId: sessionId,
        // A lost reply between identity's consume and the row below: the same take asks again and identity replays.
        requestId: `p2p:take-step-up:${take.tradeId}`,
        consumerPrincipalId: caller.userId,
      });
    } catch (err) {
      // Identity answered and refused (spent, expired, foreign or mismatched): the person confirms again.
      if (err instanceof ActionApprovalConsumeError && err.code === ACTION_APPROVAL_CONSUME_FAILED) {
        return refuseFailed('the confirmation could not be used for this order; confirm it again');
      }
      // Unwired or no answer: a new confirmation would fail the same way.
      throw new TakeStepUpError(
        'p2p.step_up_unverifiable: the confirmation could not be checked; nothing was placed',
        'p2p.step_up_unverifiable',
      );
    }
    if (
      consumed.kind !== 'same_person' ||
      consumed.status !== 'CONSUMED' ||
      consumed.requesterId !== caller.userId ||
      consumed.approverId !== caller.userId ||
      consumed.targetService !== 'svc-p2p' ||
      consumed.targetId !== TAKE_STEP_UP_SCOPE
    ) {
      refuseFailed('the confirmation is not this person’s confirmation of this order');
    }
    await sql`
      INSERT INTO p2p.take_step_ups (approval_id, user_id, session_id, trade_id, payload_hash, confirmed_at, expires_at)
      VALUES (${approvalId}, ${caller.userId}, ${sessionId}, ${take.tradeId}, ${payloadHash}, now(),
              now() + make_interval(secs => ${TAKE_STEP_UP_WINDOW_SECONDS}))
      ON CONFLICT (approval_id) DO NOTHING
    `;
  }

  return {
    async assertConfirmed(caller, take, approvalId) {
      const sessionId = sessionOf(caller);
      const id = approvalId?.trim() ?? '';
      if (id) return consume(caller, sessionId, take, id);
      const last = await latest(caller.userId, sessionId);
      if (last === null) return refuseRequired('confirm this order with your authenticator code or passkey');
      if (!last.live) {
        throw new TakeStepUpError(
          'auth.step_up_expired: the last confirmation has ended; confirm this order again',
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

/** No approval consumer and no database: every take refuses, so a missing wire never reads as "no confirmation needed". */
export function unwiredTakeStepUp(): TakeStepUp {
  return {
    async assertConfirmed() {
      throw new TakeStepUpError('p2p.step_up_unverifiable: take confirmation is not wired in this deployment', 'p2p.step_up_unverifiable');
    },
    async window() {
      return { confirmedUntil: null };
    },
  };
}
