/**
 * Support trade summary (D-ops-06): one customer's futures positions, liquidation rungs and orders, read for svc-support.
 *
 * The contract is `@intafaced/contracts` `support-trade-summary`. This file serves it and nothing else: it is a read, it
 * posts no entry and it holds no balance.
 *
 * WHO CHECKS WHAT. svc-support decides whether the agent has a case on the customer, before it calls. svc-trade proves the
 * caller (the router door) and writes the audit row. It cannot read the support tables and does not pretend to.
 *
 * WHOLE OR REFUSED. Every section is read in one repeatable-read transaction, so the three lists describe one moment. A
 * section that fails to read refuses the whole summary (`trade.support_summary_unavailable`); it never shows as an empty
 * list or a zero. The audit row is written in the same transaction after the reads and before anything is returned: when
 * it cannot be written the transaction rolls back and nothing is served (`trade.support_summary_audit_unavailable`).
 *
 * AUDIT. The row goes in `trade.operator_audit` (append-only): kind `support.trade_summary.read`, operator = agent id,
 * account = customer id, object = case id. Its id is `auditId`, a business key: a UUID derived from the case, agent,
 * customer, bound and `readAt`. It is not random, so the same read written twice (a retry inside one millisecond) is one
 * row, and a later read is its own row, which is what an audit of reads wants.
 *
 * NO NEW FIELDS. Positions are `presentPosition` (the customer's own position view) narrowed to the contract. Orders are
 * `presentCcxtOrder` narrowed. A rung is its kind, state and two timestamps; its plan, sizes and insurance amounts are never
 * selected.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  supportTradeSummarySchema,
  type SupportTradeLiquidation,
  type SupportTradeOrder,
  type SupportTradePosition,
  type SupportTradeSummary,
  type SupportTradeSummaryErrorCode,
  type SupportTradeSummaryInput,
} from '@intafaced/contracts';
import { presentPosition, type PositionRow } from '../futures/position-service.js';
import { LIQUIDATION_PRICE_NOT_RECORDED } from '../futures/futures-reads.js';
import { presentCcxtOrder } from '../private-rest.js';
import { toOrder, type OrderRow } from '../spot/rows.js';
import { writeOperatorAudit } from '../admin/common.js';

export const SUPPORT_TRADE_SUMMARY_AUDIT_KIND = 'support.trade_summary.read' as const;

type RefusalCode = Exclude<SupportTradeSummaryErrorCode, 'scope.denied'>;

/** A typed refusal. The router maps it to the wire; the code is one of `SUPPORT_TRADE_SUMMARY_ERROR_CODES`. */
export class SupportTradeSummaryError extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SupportTradeSummaryError';
  }
}

/**
 * The audit id of one read: UUID-shaped, derived from what the read was. A hash of the business key, never `randomUUID()`.
 * `readAt` is the instant the read took, so each read is its own record and an identical write is the same row.
 */
export function supportTradeSummaryAuditId(input: {
  readonly caseId: string;
  readonly agentId: string;
  readonly userId: string;
  readonly limit: number;
  readonly readAt: string;
}): string {
  const key = ['support.tradeSummary', input.caseId, input.agentId, input.userId, String(input.limit), input.readAt].join('|');
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The customer position view narrowed to the contract. A null figure carries its reason; no field is added. */
export function toSupportPosition(row: PositionRow): SupportTradePosition {
  const view = presentPosition(row);
  const reasons: Record<string, string> = {};
  if (view.maintenanceMargin == null && view.fieldReasons?.maintenanceMargin)
    reasons.maintenanceMargin = view.fieldReasons.maintenanceMargin;
  if (view.closedAt == null && view.fieldReasons?.closedAt) reasons.closedAt = view.fieldReasons.closedAt;
  if (view.leverage == null && view.leverageReason) reasons.leverage = view.leverageReason;
  if (view.liquidationPrice == null) reasons.liquidationPrice = LIQUIDATION_PRICE_NOT_RECORDED;
  return {
    positionId: view.id as string,
    symbol: view.symbol,
    side: view.side,
    status: view.status as SupportTradePosition['status'],
    closingReason: view.closingReason ?? null,
    contracts: view.contracts,
    entryPrice: view.entryPrice,
    liquidationPrice: view.liquidationPrice,
    marginMode: view.marginMode,
    marginAsset: row.margin_asset,
    collateral: view.collateral,
    initialMargin: view.initialMargin,
    maintenanceMargin: view.maintenanceMargin,
    leverage: view.leverage,
    openedAt: view.openedAt as string,
    closedAt: view.closedAt ?? null,
    ...(Object.keys(reasons).length > 0 ? { fieldReasons: reasons } : {}),
  };
}

interface OrderReadRow extends OrderRow {
  symbol: string;
  has_stop_trigger: boolean;
}

/** The customer order view narrowed to the contract. A stop-limit shows as one, as it does on the customer's own list. */
export function toSupportOrder(row: OrderReadRow): SupportTradeOrder {
  const view = presentCcxtOrder(toOrder(row), row.symbol);
  return {
    orderId: view.id,
    symbol: view.symbol,
    side: view.side,
    type: row.has_stop_trigger && view.type === 'limit' ? 'stop_limit' : view.type,
    status: view.status,
    qty: view.amount,
    filledQty: view.filled,
    limitPrice: view.price,
    rejectCode: view.rejectCode,
    recoveryRequired: view.recoveryRequired,
    createdAt: view.datetime,
  };
}

interface RungReadRow {
  rung_id: string;
  position_id: string;
  kind: SupportTradeLiquidation['kind'];
  state: SupportTradeLiquidation['state'];
  created_at: Date;
  updated_at: Date;
}

export function toSupportLiquidation(row: RungReadRow): SupportTradeLiquidation {
  return {
    rungId: row.rung_id,
    positionId: row.position_id,
    kind: row.kind,
    state: row.state,
    startedAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Cut a `limit + 1` fetch to `limit`. `truncated` is true only when the extra row existed. */
function cut<T>(rows: readonly T[], limit: number): { items: T[]; truncated: boolean } {
  return { items: rows.slice(0, limit), truncated: rows.length > limit };
}

export interface SupportTradeSummaryReaderDeps {
  readonly sql: Sql;
  readonly now?: () => Date;
}

export class SupportTradeSummaryReader {
  private readonly now: () => Date;

  constructor(private readonly deps: SupportTradeSummaryReaderDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * `caller` is the proven service name from the door; it goes in the audit detail. `limit` absent refuses: there is no
   * default bound.
   */
  async read(caller: string, input: SupportTradeSummaryInput): Promise<SupportTradeSummary> {
    const limit = input.limit;
    if (limit === undefined) {
      throw new SupportTradeSummaryError(
        'trade.support_summary_limit_unset',
        'support trade summary limit is unset, refusing to invent a bound',
      );
    }
    const readAt = this.now().toISOString();
    const auditId = supportTradeSummaryAuditId({ caseId: input.caseId, agentId: input.agentId, userId: input.userId, limit, readAt });
    try {
      return await this.deps.sql.begin('isolation level repeatable read', async (tx) => {
        let summary: SupportTradeSummary;
        try {
          const positions = await tx<PositionRow[]>`
            SELECT p.*, m.symbol, m.contract_size
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
             WHERE p.user_id = ${input.userId}
             ORDER BY p.opened_at DESC, p.id DESC
             LIMIT ${limit + 1}`;
          const rungs = await tx<RungReadRow[]>`
            SELECT r.rung_id, r.position_id, r.kind, r.state, r.created_at, r.updated_at
              FROM trade.liquidation_rungs r
              JOIN trade.positions p ON p.id::text = r.position_id
             WHERE p.user_id = ${input.userId}
             ORDER BY r.created_at DESC, r.rung_id DESC
             LIMIT ${limit + 1}`;
          const orders = await tx<OrderReadRow[]>`
            SELECT o.*, m.symbol, (t.order_id IS NOT NULL) AS has_stop_trigger
              FROM trade.orders o
              JOIN trade.markets m ON m.id = o.market_id
              LEFT JOIN trade.order_stop_trigger t ON t.order_id = o.id
             WHERE o.user_id = ${input.userId}
             ORDER BY o.created_at DESC, o.id DESC
             LIMIT ${limit + 1}`;
          const p = cut(positions, limit);
          const l = cut(rungs, limit);
          const o = cut(orders, limit);
          summary = supportTradeSummarySchema.parse({
            userId: input.userId,
            caseId: input.caseId,
            agentId: input.agentId,
            auditId,
            readAt,
            limit,
            positions: { items: p.items.map(toSupportPosition), truncated: p.truncated },
            liquidations: { items: l.items.map(toSupportLiquidation), truncated: l.truncated },
            orders: { items: o.items.map(toSupportOrder), truncated: o.truncated },
          });
        } catch (cause) {
          throw new SupportTradeSummaryError('trade.support_summary_unavailable', 'a section of the trade summary could not be read', {
            cause,
          });
        }
        try {
          await writeOperatorAudit(
            tx as unknown as Sql,
            {
              id: auditId,
              kind: SUPPORT_TRADE_SUMMARY_AUDIT_KIND,
              operatorId: input.agentId,
              accountId: input.userId,
              objectId: input.caseId,
              approverId: null,
              reason: null,
              detail: {
                caseId: input.caseId,
                agentId: input.agentId,
                userId: input.userId,
                limit,
                calledBy: caller,
                positions: { count: summary.positions.items.length, truncated: summary.positions.truncated },
                liquidations: { count: summary.liquidations.items.length, truncated: summary.liquidations.truncated },
                orders: { count: summary.orders.items.length, truncated: summary.orders.truncated },
              },
            },
            new Date(readAt),
          );
        } catch (cause) {
          throw new SupportTradeSummaryError(
            'trade.support_summary_audit_unavailable',
            'the audit row for this read could not be written, so nothing is served',
            { cause },
          );
        }
        return summary;
      });
    } catch (err) {
      if (err instanceof SupportTradeSummaryError) throw err;
      throw new SupportTradeSummaryError('trade.support_summary_unavailable', 'the trade summary could not be read', { cause: err });
    }
  }
}
