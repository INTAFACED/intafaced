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
import { consumeFounderApproval, type ApprovalConsumer } from '../operator-desks.js';
import type { ListingDecision, ListingKind, ListingStore } from './store.js';

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
 * `<action>:<targetId>:<approvalId>`. A crash after the consume and before the write is replayed with the same key, which
 * identity answers as already consumed by this request, so the decision is written once.
 *
 * Applying the same move under a different approval is a no-op with a note: the state does not change and the second
 * decision is still logged.
 */
export class ProtocolListingDesk {
  constructor(private readonly deps: ListingDeskDeps) {}

  hidePool(requesterId: string, input: { chainId: number; poolAddress: string; reasonCode: string; reason: string; approvalId: string }) {
    return this.apply(MOVES['protocol.pool.hide'], poolTargetId(input.chainId, input.poolAddress), requesterId, input);
  }
  restorePool(requesterId: string, input: { chainId: number; poolAddress: string; approvalId: string }) {
    return this.apply(MOVES['protocol.pool.restore'], poolTargetId(input.chainId, input.poolAddress), requesterId, input);
  }
  delistMarket(requesterId: string, input: { symbol: string; reasonCode: string; reason: string; approvalId: string }) {
    return this.apply(MOVES['protocol.market.delist'], marketTargetId(input.symbol), requesterId, input);
  }
  restoreMarket(requesterId: string, input: { symbol: string; approvalId: string }) {
    return this.apply(MOVES['protocol.market.restore'], marketTargetId(input.symbol), requesterId, input);
  }

  private async apply(
    move: Move,
    targetId: string,
    requesterId: string,
    input: { approvalId: string; reasonCode?: string; reason?: string },
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

    const current = (await this.deps.store.state(move.kind, targetId))?.state ?? 'visible';
    const fields: Record<string, string> = { targetId };
    if (needsReason) Object.assign(fields, { reasonCode: input.reasonCode ?? '', reason: input.reason ?? '' });
    const consumed = await consumeFounderApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      operationId: key,
      actionType: move.action,
      targetService: PROTOCOL_OPS_TARGET_SERVICE,
      targetId,
      fields,
      requesterId,
    });

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
    return resultOf(await this.deps.store.record(decision, this.deps.now()));
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
