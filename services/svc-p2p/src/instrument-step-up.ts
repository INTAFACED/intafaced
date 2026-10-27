/**
 * P-ads-merchant-18 (J-p2p-04 #3): adding, changing or removing a payment method is confirmed with a fresh passkey or
 * authenticator code, every time.
 *
 * The person proves a factor at identity (`stepUp.begin` / `stepUp.complete`) for one change: scope
 * `p2p.step_up.instruments.change`, fields instrumentId, change (create, update or remove) and detailsDigest (the
 * SHA-256 of the details it saves, `p2pInstrumentDetailsDigest`; empty when it saves none). Identity mints a single-use
 * same-person approval bound to the user and the session that proved it; svc-p2p recomputes the hash from the request
 * itself, consumes the approval once and records it here. So one confirmation approves one account number on one
 * method: unlike a take or a release there is no window, because the saved destination is the thing a stolen session
 * would change. The record lets the same change be resent with the same approval for ten minutes after a lost answer.
 *
 * Fails closed: identity unwired or unreachable (`p2p.step_up_unverifiable`), a spent, foreign, expired or mismatched
 * approval, or no confirmation at all each refuse before anything is stored.
 */
import { ACTION_APPROVAL_CONSUME_FAILED, customerStepUpPayloadHash, type ActionApproval } from '@intafaced/contracts';
import { p2pInstrumentDetailsDigest } from '@intafaced/contracts/p2p-rule-class';
import type { Sql } from 'postgres';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';
import { TakeStepUpError, type TakeStepUpCaller } from './take-step-up.js';

export const INSTRUMENT_STEP_UP_SCOPE = 'p2p.step_up.instruments.change' as const;
/** How long a used confirmation still answers a resend of the very same change after a lost answer: ten minutes. */
export const INSTRUMENT_STEP_UP_RETRY_SECONDS = 600;

export type InstrumentChange = 'create' | 'update' | 'remove';

/** One change as svc-p2p received it: the details are those the request saves, or undefined when it saves none. */
export interface InstrumentChangeRequest {
  readonly instrumentId: string;
  readonly change: InstrumentChange;
  readonly details: Readonly<Record<string, string>> | undefined;
  readonly approvalId: string | undefined;
}

export interface InstrumentStepUp {
  /** Refuses unless this change carries a valid confirmation of exactly this change and these details. */
  assertConfirmed(caller: TakeStepUpCaller, request: InstrumentChangeRequest): Promise<void>;
}

/** The hash identity minted the approval over: the person, the method, the kind of change and the details' digest. */
export function instrumentStepUpPayloadHash(userId: string, instrumentId: string, change: InstrumentChange, detailsDigest: string): string {
  return customerStepUpPayloadHash(INSTRUMENT_STEP_UP_SCOPE, { actor: userId, instrumentId, change, detailsDigest });
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

  async function consume(caller: TakeStepUpCaller, sessionId: string, request: InstrumentChangeRequest, approvalId: string) {
    const { instrumentId, change } = request;
    const payloadHash = instrumentStepUpPayloadHash(caller.userId, instrumentId, change, await p2pInstrumentDetailsDigest(request.details));
    // A resend of this very change with this approval after a lost answer: its row says so, and identity is not asked again.
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
              now() + make_interval(secs => ${INSTRUMENT_STEP_UP_RETRY_SECONDS}))
      ON CONFLICT (approval_id) DO NOTHING
    `;
  }

  return {
    async assertConfirmed(caller, request) {
      const sessionId = sessionOf(caller);
      const id = request.approvalId?.trim() ?? '';
      if (!id) return refuseRequired('confirm this change with your authenticator code or passkey');
      return consume(caller, sessionId, request, id);
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
  };
}
