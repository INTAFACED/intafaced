import 'server-only';
import type { ActionApproval } from '@intafaced/contracts';
import { parseApproval } from './approvals-parse';
import {
  parseInsuranceHistory,
  parseLiquidationDesk,
  parsePosition,
  parsePositionsPage,
  parsePriceBandView,
  parseRiskCurrent,
  parseRiskHistory,
  type AdminPositionRow,
  type InsuranceHistory,
  type LiquidationDesk,
  type PositionsPage,
  type PriceBandView,
  type RiskCurrent,
  type RiskVersionRow,
} from './desk-parse';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';
import type { RiskLimitsWrite, RiskSetBody } from './risk-limits-model';
import { RISK_SET_ACTION_TYPE, RISK_SET_POLICY_VERSION, RISK_SET_TARGET_SERVICE, riskSetPayloadHash } from './risk-set-hash';
import { BUST_ACTION_TYPE, BUST_POLICY_VERSION, BUST_TARGET_SERVICE, bustPayloadHash, type BustBody } from './bust-hash';
import {
  parseOrderRead,
  parseReconcileStatus,
  parseSweepResult,
  parseTradeAudit,
  type OrderRead,
  type ReconcileStatus,
  type SweepResult,
  type TradeAuditRow,
} from './order-read';

/**
 * svc-trade operator procedures reached through svc-edge (`/api/trade/trpc/admin.*`). Every read is audited by the
 * service. A page size is always sent: the service refuses a blank one rather than inventing it.
 */

export const POSITIONS_PAGE_SIZE = 100;
export const DESK_PAGE_SIZE = 100;

/** admin.positions.list. `accountId` is the user id; `market` is a market uuid. */
export function readPositions(
  ctx: TradeCtx,
  filter: { accountId?: string; market?: string; cursor?: string },
): Promise<Outcome<PositionsPage>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.positions.list', 'query', { ...filter, limit: POSITIONS_PAGE_SIZE }, parsePositionsPage));
}

/** admin.positions.get. 404 position_not_found arrives as a refusal. */
export function readPosition(ctx: TradeCtx, positionId: string): Promise<Outcome<AdminPositionRow>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.positions.get', 'query', { positionId }, parsePosition));
}

/** admin.risk.get: version "0" with every limit null means none was ever set. */
export function readRisk(ctx: TradeCtx, market: string): Promise<Outcome<RiskCurrent>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.risk.get', 'query', { market }, parseRiskCurrent));
}

/** admin.risk.history: every version, oldest first. */
export function readRiskHistory(ctx: TradeCtx, market: string): Promise<Outcome<readonly RiskVersionRow[]>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.risk.history', 'query', { market }, parseRiskHistory));
}

/** admin.risk.priceBand: a futures market's band as the job last worked it out, and each change, newest first. */
export function readPriceBand(ctx: TradeCtx, market: string): Promise<Outcome<PriceBandView>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.risk.priceBand', 'query', { market }, parsePriceBandView));
}

/**
 * identity actionApproval.propose for a limit change. The approval is bound to this market, the version the desk read
 * and the hash of exactly what will be written; a second founder approves it in the Approvals room.
 */
export function proposeRiskSet(ctx: TradeCtx, body: RiskSetBody): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: RISK_SET_ACTION_TYPE,
        targetService: RISK_SET_TARGET_SERVICE,
        targetId: body.market,
        expectedVersion: body.expectedVersion,
        payloadHash: riskSetPayloadHash(body),
        policyVersion: RISK_SET_POLICY_VERSION,
      },
      parseApproval,
    ),
  );
}

export interface RiskSetInput {
  readonly market: string;
  readonly limits: RiskLimitsWrite;
  readonly expectedVersion: string;
  readonly reason: string;
  readonly approvalId: string;
  /** The approval's own operation id, read from identity: the consume refuses any other. */
  readonly operationId: string;
}

/**
 * admin.risk.set. Needs a second operator's approval for action type trade.risk_set; the service consumes it and
 * refuses a stale version, a reused approval or one bound to a different payload. Never retried here.
 */
export function writeRisk(ctx: TradeCtx, input: RiskSetInput): Promise<Outcome<RiskVersionRow>> {
  return edgeCall(
    ctx,
    trpcSpec('trade', 'admin.risk.set', 'mutation', input, (raw) => {
      const rows = parseRiskHistory([raw]);
      return rows?.[0] ?? null;
    }),
  );
}

/** admin.futures.liquidations: rungs, parked positions, nearest to liquidation, ADL pairs, owed payouts. */
export function readLiquidations(ctx: TradeCtx, market?: string): Promise<Outcome<LiquidationDesk>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'trade',
      'admin.futures.liquidations',
      'query',
      { ...(market ? { market } : {}), limit: DESK_PAGE_SIZE },
      parseLiquidationDesk,
    ),
  );
}

/** admin.futures.insuranceHistory for one asset. */
export function readInsuranceHistory(ctx: TradeCtx, asset: string): Promise<Outcome<InsuranceHistory>> {
  return edgeCall(
    ctx,
    trpcSpec('trade', 'admin.futures.insuranceHistory', 'query', { asset, limit: DESK_PAGE_SIZE }, parseInsuranceHistory),
  );
}

// ── One order, the reconcile sweep, the trade bust and the trade audit (J-cex-spot-18) ──────────────────────────

/** admin.orders.get: one order in any state, with its fills and reject code. The service audits each read. */
export function readOrder(ctx: TradeCtx, orderId: string): Promise<Outcome<OrderRead>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.orders.get', 'query', { orderId }, parseOrderRead));
}

/**
 * admin.orders.startReconcileSweep. The request id is minted once per press by the caller, so a resend of the same press
 * is the same run (the service keeps each run under it). Refuses while the owner's sweep values are blank.
 */
export function startReconcileSweep(ctx: TradeCtx, input: { clientRequestId: string; reason: string }): Promise<Outcome<SweepResult>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.orders.startReconcileSweep', 'mutation', input, parseSweepResult));
}

/** admin.orders.reconcileStatus: the last sweep and its counts, for the Health room's reconcile tile (J-cex-spot-20 #2). */
export function readReconcileStatus(ctx: TradeCtx): Promise<Outcome<ReconcileStatus>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.orders.reconcileStatus', 'query', undefined, parseReconcileStatus));
}

/** identity actionApproval.propose for a trade bust, bound to the order's fill count and the reason (bust-hash.ts). */
export function proposeBust(ctx: TradeCtx, body: BustBody): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: BUST_ACTION_TYPE,
        targetService: BUST_TARGET_SERVICE,
        targetId: body.orderId,
        expectedVersion: body.expectedVersion,
        payloadHash: bustPayloadHash(body),
        policyVersion: BUST_POLICY_VERSION,
      },
      parseApproval,
    ),
  );
}

/**
 * admin.orders.bust under an APPROVED request, with the approval's own operation id as the request id (identity's
 * consume refuses any other). svc-trade answers `trade_bust_recipe_missing` until a reversal recipe exists.
 */
export function carryOutBust(
  ctx: TradeCtx,
  input: { orderId: string; approvalId: string; operationId: string; reason: string },
): Promise<Outcome<unknown>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'trade',
      'admin.orders.bust',
      'mutation',
      { orderId: input.orderId, approvalId: input.approvalId, clientRequestId: input.operationId, reason: input.reason },
      (raw) => raw ?? null,
    ),
  );
}

export const TRADE_AUDIT_PAGE_SIZE = 200;

/** admin.audit.feed: svc-trade's operator audit, oldest first, filtered by kind and account. */
export function readTradeAudit(
  ctx: TradeCtx,
  filter: { kind?: string; accountId?: string; cursor?: string },
): Promise<Outcome<{ rows: TradeAuditRow[]; nextCursor: string | null }>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.audit.feed', 'query', { ...filter, limit: TRADE_AUDIT_PAGE_SIZE }, parseTradeAudit));
}
