/**
 * P-ads-merchant-18 (J-p2p-04 #3): adding, changing or removing a payment method is confirmed with a fresh passkey or
 * authenticator code.
 *
 * The person proves a factor at identity (`stepUp.begin` / `stepUp.complete`) for one change: scope
 * `p2p.step_up.instruments.change`, fields instrumentId and change (create, update or remove). Identity mints a
 * single-use same-person approval bound to the user and the session that proved it; svc-p2p recomputes the hash,
 * consumes the approval once and records it here. That session may then change its payment methods for ten minutes
 * without another confirmation; any other session, and any API key, cannot. A take's or a release's confirmation never
 * covers a payment-method change, nor this one an order: each has its own record.
 *
 * Fails closed: identity unwired or unreachable (`p2p.step_up_unverifiable`), a spent, foreign, expired or mismatched
 * approval, a window that has ended, or no confirmation at all each refuse before anything is stored.
 */
import { ACTION_APPROVAL_CONSUME_FAILED, customerStepUpPayloadHash, type ActionApproval } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';
import { TakeStepUpError, type TakeStepUpCaller } from './take-step-up.js';

export const INSTRUMENT_STEP_UP_SCOPE = 'p2p.step_up.instruments.change' as const;
/** How long one confirmation covers further payment-method changes in the same session: ten minutes, as for a release. */
export const INSTRUMENT_STEP_UP_WINDOW_SECONDS = 600;

export type InstrumentChange = 'create' | 'update' | 'remove';

export interface InstrumentStepUp {
  /** Refuses unless this change carries a valid confirmation, or this session confirmed one in the last ten minutes. */
  assertConfirmed(caller: TakeStepUpCaller, instrumentId: string, change: InstrumentChange, approvalId: string | undefined): Promise<void>;
  /** Until when this session's payment-method changes need no new confirmation, or null when the next one does. */
  window(caller: TakeStepUpCaller): Promise<{ readonly confirmedUntil: Date | null }>;
}

/** The hash identity minted the approval over: the person, the method and the kind of change, as the client sent them. */
export function instrumentStepUpPayloadHash(userId: string, instrumentId: string, change: InstrumentChange): string {
  return customerStepUpPayloadHash(INSTRUMENT_STEP_UP_SCOPE, { actor: userId, instrumentId, change });
}

const refuseRequired = (why: string): never => {
  throw new TakeStepUpError(`auth.step_up_required: ${why}`, 'auth.step_up_required');
};
const refuseFailed = (why: string): never => {
  throw new TakeStepUpError(`auth.step_up_failed: ${why}`, 'auth.step_up_failed');
};

type UseRow = { user_id: string; session_id: string; instrument_id: string; change: string; payload_hash: string; live: boolean };

export function createInstrumentStepUp(deps: { readonly sql: Sql; readonly approvals: ActionApprovalConsumer }): InstrumentStepUp {
  const { sql, approvals } = deps;

  function sessionOf(caller: TakeStepUpCaller): string {
    if (caller.viaApiKey) refuseRequired('an API key cannot change payment methods; change them from a signed-in session');
    const sessionId = caller.sessionId?.trim() ?? '';
    if (!sessionId) refuseRequired('a payment-method change is confirmed in a signed-in session');
    return sessionId;
  }

  /** This session's latest confirmation: none, or its end and whether that is still ahead (the database clock decides). */
  async function latest(userId: string, sessionId: string): Promise<{ readonly until: Date; readonly live: boolean } | null> {
    const [row] = await sql<{ until: Date | null; live: boolean | null }[]>`
      SELECT max(expires_at) AS until, max(expires_at) > now() AS live
        FROM p2p.instrument_step_ups
       WHERE user_id = ${userId} AND session_id = ${sessionId}
    `;
    if (!row?.until) return null;
    return { until: new Date(row.until), live: row.live === true };
  }

  async function consume(caller: TakeStepUpCaller, sessionId: string, instrumentId: string, change: InstrumentChange, approvalId: string) {
    const payloadHash = instrumentStepUpPayloadHash(caller.userId, instrumentId, change);
    // A retry of this change with this approval, inside its window: its row says so, and identity is not asked again.
    const [used] = await sql<UseRow[]>`
      SELECT user_id, session_id, instrument_id::text AS instrument_id, change, payload_hash, expires_at > now() AS live
        FROM p2p.instrument_step_ups WHERE approval_id = ${approvalId}
    `;
    if (used) {
      if (
        used.user_id === caller.userId &&
        used.session_id === sessionId &&
        used.instrument_id === instrumentId.toLowerCase() &&
        used.change === change &&
        used.payload_hash === payloadHash &&
        used.live
      ) {
        return;
      }
      refuseFailed('that confirmation was already used; confirm this change again');
    }
    let consumed: ActionApproval;
    try {
      consumed = await approvals.consume({
        approvalId,
        operationId: approvalId,
        payloadHash,
        targetService: 'svc-p2p',
        targetId: INSTRUMENT_STEP_UP_SCOPE,
        expectedVersion: '1',
        principalUserId: caller.userId,
        principalSessionId: sessionId,
        // A lost reply between identity's consume and the row below: the same change asks again and identity replays.
        requestId: `p2p:instrument-step-up:${change}:${instrumentId.toLowerCase()}`,
        consumerPrincipalId: caller.userId,
      });
    } catch (err) {
      // Identity answered and refused (spent, expired, foreign or mismatched): the person confirms again.
      if (err instanceof ActionApprovalConsumeError && err.code === ACTION_APPROVAL_CONSUME_FAILED) {
        return refuseFailed('the confirmation could not be used for this change; confirm it again');
      }
      // Unwired or no answer: a new confirmation would fail the same way.
      throw new TakeStepUpError(
        'p2p.step_up_unverifiable: the confirmation could not be checked; nothing was changed',
        'p2p.step_up_unverifiable',
      );
    }
    if (
      consumed.kind !== 'same_person' ||
      consumed.status !== 'CONSUMED' ||
      consumed.requesterId !== caller.userId ||
      consumed.approverId !== caller.userId ||
      consumed.targetService !== 'svc-p2p' ||
      consumed.targetId !== INSTRUMENT_STEP_UP_SCOPE
    ) {
      refuseFailed('the confirmation is not this person’s confirmation of this change');
    }
    await sql`
      INSERT INTO p2p.instrument_step_ups (approval_id, user_id, session_id, instrument_id, change, payload_hash, confirmed_at, expires_at)
      VALUES (${approvalId}, ${caller.userId}, ${sessionId}, ${instrumentId}, ${change}, ${payloadHash}, now(),
              now() + make_interval(secs => ${INSTRUMENT_STEP_UP_WINDOW_SECONDS}))
      ON CONFLICT (approval_id) DO NOTHING
    `;
  }

  return {
    async assertConfirmed(caller, instrumentId, change, approvalId) {
      const sessionId = sessionOf(caller);
      const id = approvalId?.trim() ?? '';
      if (id) return consume(caller, sessionId, instrumentId, change, id);
      const last = await latest(caller.userId, sessionId);
      if (last === null) return refuseRequired('confirm this change with your authenticator code or passkey');
      if (!last.live) {
        throw new TakeStepUpError(
          'auth.step_up_expired: the last confirmation has ended; confirm this change again',
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

/** No approval consumer and no database: every change refuses, so a missing wire never reads as "no confirmation needed". */
export function unwiredInstrumentStepUp(): InstrumentStepUp {
  return {
    async assertConfirmed() {
      throw new TakeStepUpError(
        'p2p.step_up_unverifiable: payment-method confirmation is not wired in this deployment',
        'p2p.step_up_unverifiable',
      );
    },
    async window() {
      return { confirmedUntil: null };
    },
  };
}
