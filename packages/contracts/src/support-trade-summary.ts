import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * Support trade summary: a read-only view of one customer's futures positions, liquidation history and orders, served by
 * svc-trade to svc-support (D-ops-06, `derivatives-OPS-005`). Contracts first; svc-trade serves it and svc-support calls it
 * in later pull requests.
 *
 * Browser-safe: zod only at run time (the service name import is type-only), so the admin app can import it through
 * `@intafaced/contracts/support-trade-summary`.
 *
 * WHO CHECKS WHAT. svc-trade cannot read the support tables, so it cannot know whether an agent has a case on a customer.
 * svc-support decides that before it calls, from its own tickets: no case on this customer for this agent means svc-support
 * answers `scope.denied` and never calls svc-trade. svc-trade proves only the caller (`serviceProcedureFor`, listed in
 * `SUPPORT_TRADE_SUMMARY_CALLERS`) and then writes an audit row with the agent id and the case id before it returns, so a read
 * that cannot be audited is refused, not served.
 *
 * NO WRITE, NO EXTRA MONEY. This is a query. There is no mutation beside it, and every item is `.strict()`, so a field that is
 * not named here (an insurance amount, a ledger account, a realised figure, a fee) fails the parse instead of passing through.
 * Each figure is one the customer already sees in their own positions and orders. Money is a decimal string: a JSON number is
 * refused, never coerced.
 */

/** The tRPC path on svc-trade's root router. A query, never a mutation. */
export const SUPPORT_TRADE_SUMMARY_PROCEDURE = 'support.tradeSummary' as const;

/** The only service allowed to call it. Passed to `serviceProcedureFor`; the list is enforced under either S2S mode. */
export const SUPPORT_TRADE_SUMMARY_CALLERS: readonly ServiceName[] = ['svc-support'];

/**
 * Typed refusals.
 * `scope.denied` is the existing auth code (`AuthErrorCode`): the agent has no case on this customer. svc-support raises it
 * before any call; it is listed here so the admin console and svc-support share one spelling.
 * `trade.support_summary_limit_unset`: `limit` was omitted. A blank bound is a refusal, not a default of 100.
 * `trade.support_summary_unavailable`: a section could not be read. The summary is whole or refused; a failed read never
 * shows as an empty list or a zero.
 * `trade.support_summary_audit_unavailable`: the audit row (agent id and case id) could not be written, so nothing is served.
 */
export const SUPPORT_TRADE_SUMMARY_ERROR_CODES = [
  'scope.denied',
  'trade.support_summary_limit_unset',
  'trade.support_summary_unavailable',
  'trade.support_summary_audit_unavailable',
] as const;
export type SupportTradeSummaryErrorCode = (typeof SUPPORT_TRADE_SUMMARY_ERROR_CODES)[number];
export const supportTradeSummaryErrorCodeSchema = z.enum(SUPPORT_TRADE_SUMMARY_ERROR_CODES);

/**
 * Schema bound on the list size, an input-safety limit and not a product default (the same shape as `searchKbInputSchema`).
 * Omitted `limit` reaches the service and is refused with `trade.support_summary_limit_unset`.
 */
export const SUPPORT_TRADE_SUMMARY_LIMIT_MAX = 500;

/** A non-negative decimal string, at most 18 places: the wire rule in `instruments.ts` and `ticket-order.ts`. A number is refused. */
const amount = z
  .string({ invalid_type_error: 'JS number refused — amounts are decimal strings' })
  .regex(/^\d+(\.\d{1,18})?$/, 'amounts are decimal strings with at most 18 decimal places');

const timestamp = z.string().datetime();
/** Market symbol as the customer sees it (`BTC/USDT-PERP`, `BTC/USDT:USDT-251226`). Bounded, not pattern-matched: a dated symbol has a colon. */
const symbol = z.string().min(1).max(64);

export const supportTradeSummaryInputSchema = z
  .object({
    /** The customer whose trade summary is read. */
    userId: z.string().uuid(),
    /** The support case (the ticket id) the agent holds on this customer. Required: there is no case-less read. */
    caseId: z.string().uuid(),
    /** The support agent making the read. Recorded in svc-trade's audit row with the case id. */
    agentId: z.string().uuid(),
    /** Rows per list (positions, liquidation events, orders). Optional so an omitted bound reaches the named refusal. */
    limit: z.number().int().positive().max(SUPPORT_TRADE_SUMMARY_LIMIT_MAX).optional(),
  })
  .strict();
export type SupportTradeSummaryInput = z.infer<typeof supportTradeSummaryInputSchema>;

/**
 * One futures position as the customer sees it (`positionSchema` in `@intafaced/exchange-contract`, narrowed). `contracts` is
 * the size. `collateral` is the residual margin and `initialMargin` the open stake. A figure the row never recorded is null
 * with its reason in `fieldReasons`, never a guess.
 */
export const supportTradePositionSchema = z
  .object({
    positionId: z.string().min(1),
    symbol,
    side: z.enum(['long', 'short']),
    /** `closing` = an exit was asked for while no usable mark existed; it must never render as `open`. */
    status: z.enum(['open', 'closing', 'closed', 'liquidated']),
    closingReason: z.string().min(1).nullable(),
    contracts: amount,
    entryPrice: amount,
    liquidationPrice: amount.nullable(),
    marginMode: z.enum(['cross', 'isolated']).nullable(),
    marginAsset: z.string().regex(/^[A-Z0-9]{1,16}$/),
    collateral: amount.nullable(),
    initialMargin: amount.nullable(),
    maintenanceMargin: amount.nullable(),
    leverage: amount.nullable(),
    openedAt: timestamp,
    closedAt: timestamp.nullable(),
    /** Why a field above is null. Absent when every field has a value. */
    fieldReasons: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type SupportTradePosition = z.infer<typeof supportTradePositionSchema>;

/**
 * One liquidation rung: its kind, its state and when it started and last moved. No size, margin or insurance amount: the
 * insurance fund is not a customer figure, and this view is not the desk's liquidation queue.
 */
export const SUPPORT_TRADE_RUNG_STATES = ['planned', 'posted', 'applied', 'abandoned', 'resolved'] as const;
export const supportTradeLiquidationSchema = z
  .object({
    rungId: z.string().uuid(),
    positionId: z.string().min(1),
    kind: z.enum(['partial', 'closing']),
    state: z.enum(SUPPORT_TRADE_RUNG_STATES),
    startedAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type SupportTradeLiquidation = z.infer<typeof supportTradeLiquidationSchema>;

/**
 * One order as the customer sees it (`orderSchema` in `@intafaced/exchange-contract`, narrowed). `limitPrice` is null for an
 * order with no price. `status` is the customer wire's vocabulary; `recoveryRequired` is the same flag the customer wire
 * carries for an order whose outcome is not yet known, so support never reads an unresolved order as plain `open`.
 * `rejectCode` is the engine's refusal code, or null.
 */
export const supportTradeOrderSchema = z
  .object({
    orderId: z.string().min(1),
    symbol,
    side: z.enum(['buy', 'sell']),
    type: z.enum(['market', 'limit', 'stop', 'stop_limit', 'take_profit']),
    status: z.enum(['open', 'closed', 'canceled', 'expired', 'rejected']),
    qty: amount,
    filledQty: amount,
    limitPrice: amount.nullable(),
    rejectCode: z.string().min(1).nullable(),
    recoveryRequired: z.boolean(),
    createdAt: timestamp,
  })
  .strict();
export type SupportTradeOrder = z.infer<typeof supportTradeOrderSchema>;

/** A list plus whether more rows exist beyond `limit`. Support must never read a cut list as the whole history. */
function section<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), truncated: z.boolean() }).strict();
}

/**
 * The summary. It echoes the three ids it was asked about, so the caller can refuse an answer for a different customer, case
 * or agent (`supportTradeSummaryMatches`); `auditId` and `readAt` name the audit row svc-trade wrote for this read.
 */
export const supportTradeSummarySchema = z
  .object({
    userId: z.string().uuid(),
    caseId: z.string().uuid(),
    agentId: z.string().uuid(),
    auditId: z.string().uuid(),
    readAt: timestamp,
    /** The bound the lists were cut to. */
    limit: z.number().int().positive().max(SUPPORT_TRADE_SUMMARY_LIMIT_MAX),
    positions: section(supportTradePositionSchema),
    liquidations: section(supportTradeLiquidationSchema),
    orders: section(supportTradeOrderSchema),
  })
  .strict();
export type SupportTradeSummary = z.infer<typeof supportTradeSummarySchema>;

/** True only when the summary answers the request that was sent. A misrouted or hostile answer is not accepted as the customer's. */
export function supportTradeSummaryMatches(
  input: Pick<SupportTradeSummaryInput, 'userId' | 'caseId' | 'agentId'>,
  summary: Pick<SupportTradeSummary, 'userId' | 'caseId' | 'agentId'>,
): boolean {
  return summary.userId === input.userId && summary.caseId === input.caseId && summary.agentId === input.agentId;
}
