/**
 * Futures orders through the matching book (futures ADR, slices 6 and 6b): place, cancel and list.
 *
 * While TRADE_FUTURES_MATCHING_ENABLED is on, this is the only way into and out of a futures position: an opening order
 * locks its margin hold and rests or crosses on the futures book, and a close is a reduce-only order bounded at the
 * position's bankruptcy price. The mark is read inside the service; a limit is the caller's own price, banded around it.
 * Every amount is a decimal string, and a JSON number is refused rather than read.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireScope, type Principal } from '@intafaced/auth';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { AdlDisclosureError } from './adl-disclosure.js';
import { isDerivativesAccessError, presentDerivativesAccessError } from './derivatives-access.js';
import { presentFuturesErrorWire } from './futures-error-wire.js';
import {
  FUTURES_ORDER_ORIGINS,
  MATCHED_ORDER_STATUSES,
  MatchedOrderError,
  ORDER_LABEL_INVALID,
  ORDER_LABEL_PATTERN,
  type FuturesOrderOrigin,
  type FuturesOrderQuery,
  type MatchedOrderStatus,
  type MatchedOrderView,
  type PlaceMatchedOrderInput,
} from './matched-orders.js';
import {
  FUTURES_EXECUTION_KINDS,
  FUTURES_EXECUTIONS_LIMIT_MAX,
  FuturesExecutionsError,
  type FuturesExecution,
  type FuturesExecutionKind,
  type FuturesExecutionQuery,
} from './futures-executions.js';
import { FuturesError } from './position-service.js';
import type { EntryProtectionInput, EntryProtectionView } from './conditional-orders/service.js';
import type { ReverseInput, ReverseView } from './reverse.js';
import { CONFIRM_TIER_INVALID, readConfirmTier } from './risk-tier-confirm.js';

/** The largest page one read may ask for; a blank or larger limit refuses rather than picking one. */
export const FUTURES_ORDERS_LIMIT_MAX = 500;

export type FuturesOrderWire = MatchedOrderView & { readonly symbol?: string; readonly createdAt?: string };

export interface MatchedOrdersRestDeps {
  /** Absent: the routes answer 503 `trade.futures_orders_unmounted`, never a pretend order. */
  readonly place?: (
    principal: Principal,
    input: PlaceMatchedOrderInput,
    context: { readonly region?: string | null },
  ) => Promise<FuturesOrderWire>;
  /** An opening order above the max-order as children of at most the cap; absent answers 503 like `place`. */
  readonly placeSplit?: (
    principal: Principal,
    input: PlaceMatchedOrderInput,
    context: { readonly region?: string | null },
  ) => Promise<{
    readonly parts: number;
    readonly orders: readonly FuturesOrderWire[];
    readonly stopped: { readonly child: number; readonly code: string; readonly message: string } | null;
  }>;
  readonly cancel?: (principal: Principal, orderId: string) => Promise<FuturesOrderWire>;
  readonly list?: (principal: Principal, input: FuturesOrderQuery) => Promise<readonly FuturesOrderWire[]>;
  /** One of the caller's own orders; null answers 404. Absent answers 503 like `list`. */
  readonly get?: (principal: Principal, orderId: string) => Promise<FuturesOrderWire | null>;
  /** The caller's futures executions (`futures-executions.ts`). Absent answers 503 like `list`. */
  readonly executions?: (
    principal: Principal,
    input: FuturesExecutionQuery,
  ) => Promise<{ readonly executions: readonly FuturesExecution[]; readonly next: string | null }>;
  /**
   * A take profit and a stop loss attached to an opening order: checked and recorded before the order is placed, armed
   * on its fills by the conditional job. Absent refuses an order that asks for one.
   */
  readonly entryProtection?: {
    record(userId: string, input: EntryProtectionInput): Promise<EntryProtectionView | null>;
  };
  /**
   * One-tap reverse (`reverse.ts`): one request closes the position through the book and opens the other side at the
   * same size. Absent answers 503 like `place`.
   */
  readonly reverse?: (principal: Principal, input: ReverseInput, context: { readonly region?: string | null }) => Promise<ReverseView>;
}

export interface MatchedOrdersRestGates {
  requirePrincipal(req: FastifyRequest, reply: FastifyReply): Principal | null;
  requireTradeJurisdiction(req: FastifyRequest, reply: FastifyReply, principal: Principal): boolean;
  regionOf(req: FastifyRequest): string | null | undefined;
  /** The service's shared domain mapping (auth, CCXT); null when it does not know the error. */
  sendDomainError(reply: FastifyReply, err: unknown): FastifyReply | null;
}

const ENTRY_PROTECTION_UNMOUNTED = {
  error: 'trade.entry_protection_unmounted',
  message: 'a take profit or stop loss on an opening order is not mounted on this deployment; nothing was placed',
};

const UNMOUNTED = {
  error: 'trade.futures_orders_unmounted',
  message: 'futures orders through the book are not mounted on this deployment',
};

function bad(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(400).send({ error: code, message });
}

/** A named decimal string, parsed exactly. Undefined when absent, null when present but not a decimal string. */
function decimalField(value: unknown): Amount | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return parseAmount(value.trim());
  } catch {
    return null;
  }
}

/** Reads a place body into the service input, or answers why it cannot. Exported for the route test. */
export function readPlaceBody(
  userId: string,
  raw: unknown,
): { ok: true; input: PlaceMatchedOrderInput } | { ok: false; code: string; message: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : '';
  if (!symbol) return { ok: false, code: 'trade.bad_request', message: 'symbol is required' };
  if (body.side !== 'buy' && body.side !== 'sell') return { ok: false, code: 'trade.side_invalid', message: 'side must be buy or sell' };
  if (body.type !== 'limit' && body.type !== 'market') {
    return { ok: false, code: 'trade.order_type_invalid', message: 'type must be limit or market' };
  }
  const qty = decimalField(body.amount);
  if (qty == null) return { ok: false, code: 'trade.size_invalid', message: 'amount is required as a decimal string' };
  const price = decimalField(body.price);
  if (price === null) return { ok: false, code: 'trade.invalid_price', message: 'price must be a decimal string' };
  if (body.reduceOnly !== undefined && typeof body.reduceOnly !== 'boolean') {
    return { ok: false, code: 'trade.reduce_only_invalid', message: 'reduceOnly must be a boolean' };
  }
  const reduceOnly = body.reduceOnly === true;
  // A reduce-only order keeps the position's own leverage; an opening order names its leverage and never gets 1x.
  const leverage = decimalField(body.leverage);
  if (leverage === null || (leverage === undefined && !reduceOnly)) {
    return { ok: false, code: 'trade.leverage_required', message: 'leverage is required on an opening order — it does not default to 1x' };
  }
  // The book takes a limit as GTC and a market as IOC at the band edge; another time in force refuses rather than
  // being dropped silently.
  if (body.timeInForce !== undefined && body.timeInForce !== (body.type === 'market' ? 'IOC' : 'GTC')) {
    return {
      ok: false,
      code: 'trade.time_in_force_unsupported',
      message: 'a limit order rests GTC and a market order is IOC; another time in force is not offered on the futures book yet',
    };
  }
  if (body.marginMode !== undefined && body.marginMode !== 'isolated') {
    return {
      ok: false,
      code: 'trade.margin_mode_unavailable',
      message: 'only isolated margin is live; cross and portfolio margin are refused, not switched',
    };
  }
  const clientOrderId = typeof body.clientOrderId === 'string' ? body.clientOrderId.trim() : '';
  if (!clientOrderId || clientOrderId.length > 64) {
    return {
      ok: false,
      code: 'trade.client_order_id_required',
      message: 'clientOrderId is required (1–64 chars) — omit would double-lock margin on retry',
    };
  }
  let orderLabel: string | undefined;
  if (body.orderLabel !== undefined) {
    if (typeof body.orderLabel !== 'string' || !ORDER_LABEL_PATTERN.test(body.orderLabel)) {
      return { ok: false, code: ORDER_LABEL_INVALID, message: 'orderLabel is 1 to 36 of letters, digits and . _ : -' };
    }
    orderLabel = body.orderLabel;
  }
  const confirmTier = readConfirmTier(body.confirmTier);
  if (!confirmTier.ok) {
    return { ok: false, code: CONFIRM_TIER_INVALID, message: 'confirmTier is the margin tier you accept, a whole number from 1' };
  }
  return {
    ok: true,
    input: {
      userId,
      symbol,
      side: body.side,
      type: body.type,
      qty,
      ...(price !== undefined ? { limitPrice: price } : {}),
      leverage: leverage ?? 0n,
      clientOrderId,
      ...(reduceOnly ? { reduceOnly: true } : {}),
      marginMode: 'isolated',
      // Passed as sent: the service names a class it does not take (trade.unsupported_collateral_class).
      ...(body.collateralClass !== undefined ? { collateralClass: body.collateralClass } : {}),
      ...(body.priceCorrection !== undefined ? { priceCorrection: body.priceCorrection } : {}),
      ...(confirmTier.tier !== undefined ? { confirmTier: confirmTier.tier } : {}),
      ...(orderLabel !== undefined ? { orderLabel } : {}),
    },
  };
}

/** A whole-number page size from 1 to `max`; anything else is null, and the caller refuses rather than picks one. */
function pageLimit(raw: unknown, max: number): number | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const limit = /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isInteger(limit) && limit >= 1 && limit <= max ? limit : null;
}

/** A named filter: absent or blank is no filter, a value outside the known set is refused (never read as "all"). */
function filterOf<T extends string>(raw: unknown, known: readonly T[]): { ok: true; value: T | null } | { ok: false } {
  if (raw === undefined || raw === '') return { ok: true, value: null };
  return typeof raw === 'string' && (known as readonly string[]).includes(raw) ? { ok: true, value: raw as T } : { ok: false };
}

type ListQuery = { scope?: string; limit?: string; symbol?: string; label?: string; origin?: string; status?: string; before?: string };

/** Reads a list query into the service's, or answers why it cannot. Exported for the route test. */
export function readListQuery(query: ListQuery): { ok: true; input: FuturesOrderQuery } | { ok: false; code: string; message: string } {
  const scope = query.scope;
  if (scope !== 'open' && scope !== 'history' && scope !== 'all') {
    return { ok: false, code: 'trade.futures_orders_scope_invalid', message: 'scope must be open, history or all' };
  }
  const limit = pageLimit(query.limit, FUTURES_ORDERS_LIMIT_MAX);
  if (limit === null) {
    return {
      ok: false,
      code: 'trade.futures_orders_limit_unset',
      message: `limit is required, 1–${FUTURES_ORDERS_LIMIT_MAX} — refuse to invent one`,
    };
  }
  const label = typeof query.label === 'string' && query.label !== '' ? query.label : null;
  if (label !== null && !ORDER_LABEL_PATTERN.test(label)) {
    return { ok: false, code: ORDER_LABEL_INVALID, message: 'label is 1 to 36 of letters, digits and . _ : -' };
  }
  const origin = filterOf<FuturesOrderOrigin>(query.origin, FUTURES_ORDER_ORIGINS);
  if (!origin.ok) return { ok: false, code: 'trade.invalid_filter', message: `origin must be one of ${FUTURES_ORDER_ORIGINS.join(', ')}` };
  const status = filterOf<MatchedOrderStatus>(query.status, MATCHED_ORDER_STATUSES);
  if (!status.ok) return { ok: false, code: 'trade.invalid_filter', message: `status must be one of ${MATCHED_ORDER_STATUSES.join(', ')}` };
  const symbol = typeof query.symbol === 'string' && query.symbol.trim() !== '' ? query.symbol.trim() : null;
  const before = typeof query.before === 'string' && query.before !== '' ? query.before : null;
  return { ok: true, input: { scope, limit, symbol, label, origin: origin.value, status: status.value, before } };
}

function sendFuturesFailure(reply: FastifyReply, err: unknown, gates: MatchedOrdersRestGates): FastifyReply | null {
  if (err instanceof MatchedOrderError || err instanceof FuturesError) return reply.code(err.status).send(presentFuturesErrorWire(err));
  if (err instanceof AdlDisclosureError) return reply.code(err.status).send({ error: err.code, message: err.message });
  if (isDerivativesAccessError(err)) return reply.code(err.status).send(presentDerivativesAccessError(err));
  return gates.sendDomainError(reply, err);
}

export function attachMatchedOrderRoutes(app: FastifyInstance, deps: MatchedOrdersRestDeps, gates: MatchedOrdersRestGates): void {
  app.post('/api/v1/futures/orders', async (req, reply) => {
    const principal = gates.requirePrincipal(req, reply);
    if (!principal) return;
    if (!gates.requireTradeJurisdiction(req, reply, principal)) return;
    if (!deps.place) return reply.code(503).send(UNMOUNTED);
    try {
      requireScope(principal, 'trade:write');
      const read = readPlaceBody(principal.userId, req.body);
      if (!read.ok) return bad(reply, read.code, read.message);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const asks = body.takeProfit !== undefined || body.stopLoss !== undefined;
      if (asks && !deps.entryProtection) return reply.code(503).send(ENTRY_PROTECTION_UNMOUNTED);
      // Recorded before the order is placed, so an order is never live with its protection unrecorded, and a
      // protection that would refuse refuses before anything is placed. The same request sent again finds the row.
      const protection = asks
        ? await deps.entryProtection!.record(principal.userId, {
            symbol: read.input.symbol,
            side: read.input.side,
            reduceOnly: read.input.reduceOnly === true,
            clientOrderId: read.input.clientOrderId,
            takeProfit: body.takeProfit,
            stopLoss: body.stopLoss,
          })
        : null;
      const order = await deps.place(principal, read.input, { region: gates.regionOf(req) ?? null });
      return reply.code(200).send(protection == null ? order : { ...order, protection });
    } catch (err) {
      const sent = sendFuturesFailure(reply, err, gates);
      if (sent) return sent;
      throw err;
    }
  });

  // The same body as a single order; the answer lists every child placed (`MatchedFuturesOrders.placeSplit`).
  app.post('/api/v1/futures/orders/split', async (req, reply) => {
    const principal = gates.requirePrincipal(req, reply);
    if (!principal) return;
    if (!gates.requireTradeJurisdiction(req, reply, principal)) return;
    if (!deps.placeSplit) return reply.code(503).send(UNMOUNTED);
    try {
      requireScope(principal, 'trade:write');
      const read = readPlaceBody(principal.userId, req.body);
      if (!read.ok) return bad(reply, read.code, read.message);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.takeProfit !== undefined || body.stopLoss !== undefined) {
        return bad(
          reply,
          'trade.entry_protection_split_unsupported',
          'a take profit or stop loss is attached to one order, not a split; set it on the position once it is open',
        );
      }
      return reply.code(200).send(await deps.placeSplit(principal, read.input, { region: gates.regionOf(req) ?? null }));
    } catch (err) {
      const sent = sendFuturesFailure(reply, err, gates);
      if (sent) return sent;
      throw err;
    }
  });

  // The same request id sent again carries the reverse on, or answers how it ended; it never places a leg twice.
  app.post<{ Params: { id: string } }>('/api/v1/positions/:id/reverse', async (req, reply) => {
    const principal = gates.requirePrincipal(req, reply);
    if (!principal) return;
    if (!gates.requireTradeJurisdiction(req, reply, principal)) return;
    if (!deps.reverse) return reply.code(503).send(UNMOUNTED);
    try {
      requireScope(principal, 'trade:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const clientRequestId = typeof body.clientRequestId === 'string' ? body.clientRequestId.trim() : '';
      if (!clientRequestId) return bad(reply, 'trade.client_request_id_required', 'clientRequestId is required');
      const tier = readConfirmTier(body.confirmTier);
      if (!tier.ok) return bad(reply, CONFIRM_TIER_INVALID, 'confirmTier is the margin tier you accept, a whole number from 1');
      const view = await deps.reverse(
        principal,
        { positionId: req.params.id, clientRequestId, ...(tier.tier !== undefined ? { confirmTier: tier.tier } : {}) },
        { region: gates.regionOf(req) ?? null },
      );
      return reply.code(200).send(view);
    } catch (err) {
      const sent = sendFuturesFailure(reply, err, gates);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Querystring: ListQuery }>('/api/v1/futures/orders', async (req, reply) => {
    const principal = gates.requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.list) return reply.code(503).send(UNMOUNTED);
    const read = readListQuery(req.query ?? {});
    if (!read.ok) return bad(reply, read.code, read.message);
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send(await deps.list(principal, read.input));
    } catch (err) {
      const sent = sendFuturesFailure(reply, err, gates);
      if (sent) return sent;
      throw err;
    }
  });

  // Executions before the `:id` route: Fastify matches the static path first either way, this keeps it readable.
  app.get<{ Querystring: { limit?: string; symbol?: string; kind?: string; orderId?: string; before?: string } }>(
    '/api/v1/futures/executions',
    async (req, reply) => {
      const principal = gates.requirePrincipal(req, reply);
      if (!principal) return;
      if (!deps.executions) return reply.code(503).send(UNMOUNTED);
      const query = req.query ?? {};
      const limit = pageLimit(query.limit, FUTURES_EXECUTIONS_LIMIT_MAX);
      if (limit === null) {
        return bad(
          reply,
          'trade.futures_executions_limit_unset',
          `limit is required, 1–${FUTURES_EXECUTIONS_LIMIT_MAX} — refuse to invent one`,
        );
      }
      const kind = filterOf<FuturesExecutionKind>(query.kind, FUTURES_EXECUTION_KINDS);
      if (!kind.ok) return bad(reply, 'trade.invalid_filter', `kind must be one of ${FUTURES_EXECUTION_KINDS.join(', ')}`);
      const symbol = typeof query.symbol === 'string' && query.symbol.trim() !== '' ? query.symbol.trim() : null;
      const before = typeof query.before === 'string' && query.before !== '' ? query.before : null;
      const orderId = typeof query.orderId === 'string' && query.orderId !== '' ? query.orderId : null;
      try {
        requireScope(principal, 'trade:read');
        return reply.code(200).send(await deps.executions(principal, { limit, symbol, kind: kind.value, orderId, before }));
      } catch (err) {
        if (err instanceof FuturesExecutionsError) return reply.code(err.status).send({ error: err.code, message: err.message });
        const sent = sendFuturesFailure(reply, err, gates);
        if (sent) return sent;
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/futures/orders/:id', async (req, reply) => {
    const principal = gates.requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.get) return reply.code(503).send(UNMOUNTED);
    try {
      requireScope(principal, 'trade:read');
      const order = await deps.get(principal, req.params.id);
      if (!order)
        return reply.code(404).send({ error: 'trade.futures_order_not_found', message: `futures order ${req.params.id} not found` });
      return reply.code(200).send(order);
    } catch (err) {
      const sent = sendFuturesFailure(reply, err, gates);
      if (sent) return sent;
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/futures/orders/:id', async (req, reply) => {
    const principal = gates.requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.cancel) return reply.code(503).send(UNMOUNTED);
    try {
      // A cancel only ever lowers exposure, so it is not held back by the trading jurisdiction gate.
      requireScope(principal, 'trade:write');
      return reply.code(200).send(await deps.cancel(principal, req.params.id));
    } catch (err) {
      const sent = sendFuturesFailure(reply, err, gates);
      if (sent) return sent;
      throw err;
    }
  });
}
