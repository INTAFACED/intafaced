import {
  marketTargetId,
  poolTargetId,
  protocolOpsIdempotencyKey,
  type ListingState,
  type ProtocolOpsAction,
  type ProtocolOpsActionResult,
  PROTOCOL_OPS_TARGET_SERVICE,
} from '@intafaced/contracts';
import { OPS_PROTOCOL_REASON_CODE_UNKNOWN, OPS_PROTOCOL_REASON_CODES_UNSET, OpsError } from '../codes.js';
import { createHash } from 'node:crypto';
import { consumeFounderApproval, type ApprovalConsumer } from '../operator-desks.js';
import type { ListingDecision, ListingDecisionDraft, ListingKind, ListingStore } from './store.js';

export interface ListingDeskDeps {
  readonly store: ListingStore;
  readonly approvals: ApprovalConsumer | undefined;
  /** The owner-published reason codes. Blank (null or empty) refuses `owner.decision`; nothing is invented. */
  readonly reasonCodes: () => readonly string[] | null;
  readonly now: () => string;
}

interface Move {
  readonly action: ProtocolOpsAction;
  readonly kind: ListingKind;
  readonly to: Exclude<ListingState, 'applying'>;
}
const MOVES: Record<ProtocolOpsAction, Move> = {
  'protocol.pool.hide': { action: 'protocol.pool.hide', kind: 'pool', to: 'hidden' },
  'protocol.pool.restore': { action: 'protocol.pool.restore', kind: 'pool', to: 'visible' },
  'protocol.market.delist': { action: 'protocol.market.delist', kind: 'market', to: 'hidden' },
  'protocol.market.restore': { action: 'protocol.market.restore', kind: 'market', to: 'visible' },
};

/**
 * Hide, restore, delist: each needs a second founder's approval, consumed once, and each is idempotent on
 * `<action>:<targetId>:<approvalId>`. The approval is spent with the operation id identity issued when it was proposed
 * (carried on the input). A repeat of a call whose decision was written returns the stored result and spends nothing.
 *
 * A crash between the spend and the write is NOT recoverable by a retry today. The request id sent on consume is the key
 * identity would use to replay the spend, but identity's replay (`consumedAgain`) returns the row without the founder
 * attestation, so the retry is refused `action_approval.not_founders`: nothing is hidden and the founders issue a fresh
 * approval. The pool stays visible, never half hidden. Making the replay carry the attestation is a svc-identity change.
 *
 * Applying the same move under a different approval is a no-op with a note: the state does not change and the second
 * decision is still logged. The store decides that under its lock.
 */
export class ProtocolListingDesk {
  constructor(private readonly deps: ListingDeskDeps) {}

  hidePool(
    requesterId: string,
    input: { chainId: number; poolAddress: string; reasonCode: string; reason: string; approvalId: string; operationId: string },
  ) {
    return this.apply(MOVES['protocol.pool.hide'], poolTargetId(input.chainId, input.poolAddress), requesterId, input);
  }
  restorePool(requesterId: string, input: { chainId: number; poolAddress: string; approvalId: string; operationId: string }) {
    return this.apply(MOVES['protocol.pool.restore'], poolTargetId(input.chainId, input.poolAddress), requesterId, input);
  }
  delistMarket(
    requesterId: string,
    input: { symbol: string; reasonCode: string; reason: string; approvalId: string; operationId: string },
  ) {
    return this.apply(MOVES['protocol.market.delist'], marketTargetId(input.symbol), requesterId, input);
  }
  restoreMarket(requesterId: string, input: { symbol: string; approvalId: string; operationId: string }) {
    return this.apply(MOVES['protocol.market.restore'], marketTargetId(input.symbol), requesterId, input);
  }

  private async apply(
    move: Move,
    targetId: string,
    requesterId: string,
    input: { approvalId: string; operationId: string; reasonCode?: string; reason?: string },
  ): Promise<ProtocolOpsActionResult> {
    const needsReason = move.to === 'hidden';
    if (needsReason) {
      const codes = this.deps.reasonCodes();
      if (!codes || codes.length === 0) {
        throw new OpsError(OPS_PROTOCOL_REASON_CODES_UNSET, 'the owner has not published the reason codes for hiding a listing.');
      }
      if (!input.reasonCode || !codes.includes(input.reasonCode)) {
        throw new OpsError(OPS_PROTOCOL_REASON_CODE_UNKNOWN, `"${input.reasonCode ?? ''}" is not a published reason code.`);
      }
    }
    const key = protocolOpsIdempotencyKey(move.action, targetId, input.approvalId.trim());
    const stored = await this.deps.store.decision(key);
    if (stored) return resultOf(stored);

    const fields: Record<string, string> = { targetId };
    if (needsReason) Object.assign(fields, { reasonCode: input.reasonCode ?? '', reason: input.reason ?? '' });
    const consumed = await consumeFounderApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      operationId: input.operationId,
      requestId: `listing:${createHash('sha256').update(key).digest('hex')}`,
      actionType: move.action,
      targetService: PROTOCOL_OPS_TARGET_SERVICE,
      targetId,
      fields,
      requesterId,
    });

    const draft: ListingDecisionDraft = {
      idempotencyKey: key,
      action: move.action,
      kind: move.kind,
      targetId,
      state: move.to,
      reasonCode: needsReason ? (input.reasonCode ?? null) : null,
      reason: needsReason ? (input.reason ?? null) : null,
      approvalId: consumed.approvalId,
      requesterId: consumed.requesterId,
      approverId: consumed.approverId ?? '',
      policyVersion: consumed.policyVersion,
    };
    return resultOf(await this.deps.store.record(draft, this.deps.now()));
  }
}

function resultOf(decision: ListingDecision): ProtocolOpsActionResult {
  return {
    action: decision.action,
    targetId: decision.targetId,
    state: decision.state,
    outcome: decision.outcome,
    note: decision.note,
    idempotencyKey: decision.idempotencyKey,
  };
}
