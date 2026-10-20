import {
  marketTargetId,
  poolTargetId,
  protocolOpsIdempotencyKey,
  type ListingState,
  type ProtocolOpsAction,
  type ProtocolOpsActionResult,
} from '@intafaced/contracts';
import { consumeOpsApproval, type ActionApprovalConsumer } from './approvals.js';
import type { ListingDecision, ListingKind, ListingStore } from './listing.js';

export class OpsRefusal extends Error {
  constructor(
    readonly code: 'owner.decision' | 'protocol.ops_reason_code_unknown',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'OpsRefusal';
  }
}

export interface OpsDeskDeps {
  store: ListingStore;
  approvals: ActionApprovalConsumer;
  /** The owner-published reason codes. Blank (null or empty) refuses `owner.decision`; nothing is invented. */
  reasonCodes: () => readonly string[] | null;
}

type Move = { action: ProtocolOpsAction; kind: ListingKind; to: ListingState };
const MOVES: Record<ProtocolOpsAction, Move> = {
  'protocol.pool.hide': { action: 'protocol.pool.hide', kind: 'pool', to: 'hidden' },
  'protocol.pool.restore': { action: 'protocol.pool.restore', kind: 'pool', to: 'visible' },
  'protocol.market.delist': { action: 'protocol.market.delist', kind: 'market', to: 'hidden' },
  'protocol.market.restore': { action: 'protocol.market.restore', kind: 'market', to: 'visible' },
};

/**
 * Hide, restore, delist: each needs a second founder's approval, consumed once, and each is idempotent on
 * `<action>:<targetId>:<approvalId>`. A crash after the consume and before the write is replayed with the same key, which
 * identity answers as already consumed by this request, so the decision is written once.
 *
 * Applying the same move under a different approval is a no-op with a note: the state does not change and the second
 * decision is still logged.
 */
export class ProtocolOpsDesk {
  constructor(private readonly deps: OpsDeskDeps) {}

  hidePool(input: { chainId: number; poolAddress: string; reasonCode: string; reason: string; approvalId: string }) {
    return this.apply(MOVES['protocol.pool.hide'], poolTargetId(input.chainId, input.poolAddress), input);
  }
  restorePool(input: { chainId: number; poolAddress: string; approvalId: string }) {
    return this.apply(MOVES['protocol.pool.restore'], poolTargetId(input.chainId, input.poolAddress), input);
  }
  delistMarket(input: { symbol: string; reasonCode: string; reason: string; approvalId: string }) {
    return this.apply(MOVES['protocol.market.delist'], marketTargetId(input.symbol), input);
  }
  restoreMarket(input: { symbol: string; approvalId: string }) {
    return this.apply(MOVES['protocol.market.restore'], marketTargetId(input.symbol), input);
  }

  private async apply(
    move: Move,
    targetId: string,
    input: { approvalId: string; reasonCode?: string; reason?: string },
  ): Promise<ProtocolOpsActionResult> {
    const needsReason = move.to === 'hidden';
    if (needsReason) {
      const codes = this.deps.reasonCodes();
      if (!codes || codes.length === 0) {
        throw new OpsRefusal('owner.decision', 'the owner has not published the reason codes for hiding a listing.');
      }
      if (!input.reasonCode || !codes.includes(input.reasonCode)) {
        throw new OpsRefusal('protocol.ops_reason_code_unknown', `"${input.reasonCode ?? ''}" is not a published reason code.`);
      }
    }
    const key = protocolOpsIdempotencyKey(move.action, targetId, input.approvalId.trim());
    const stored = await this.deps.store.decision(key);
    if (stored) return resultOf(stored);

    const current = (await this.deps.store.state(move.kind, targetId))?.state ?? 'visible';
    const fields: Record<string, string> = { action: move.action, targetId };
    if (needsReason) Object.assign(fields, { reasonCode: input.reasonCode ?? '', reason: input.reason ?? '' });
    const consumed = await consumeOpsApproval(
      this.deps.approvals,
      { approvalId: input.approvalId, operationId: key },
      { actionType: move.action, targetId },
      fields,
      `listing:${current}`,
    );

    const noop = current === move.to;
    const decision: ListingDecision = {
      idempotencyKey: key,
      action: move.action,
      kind: move.kind,
      targetId,
      outcome: noop ? 'noop' : 'applied',
      note: noop ? (needsReason ? 'Already hidden by an earlier approval.' : 'Already listed; nothing to restore.') : null,
      state: move.to,
      reasonCode: needsReason ? (input.reasonCode ?? null) : null,
      reason: needsReason ? (input.reason ?? null) : null,
      approvalId: consumed.approvalId,
      requesterId: consumed.requesterId,
      approverId: consumed.approverId ?? '',
      policyVersion: consumed.policyVersion,
    };
    const written = await this.deps.store.record(
      decision,
      noop
        ? null
        : {
            kind: move.kind,
            targetId,
            state: move.to,
            reasonCode: decision.reasonCode,
            reason: decision.reason,
            approvalId: decision.approvalId,
            policyVersion: decision.policyVersion,
          },
    );
    return resultOf(written);
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
