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
import { MatchedOrderError, type MatchedOrderView, type PlaceMatchedOrderInput } from './matched-orders.js';
import { FuturesError } from './position-service.js';

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
  readonly cancel?: (principal: Principal, orderId: string) => Promise<FuturesOrderWire>;
  readonly list?: (
    principal: Principal,
    input: { readonly scope: 'open' | 'all'; readonly limit: number; readonly symbol?: string | null },
  ) => Promise<readonly FuturesOrderWire[]>;
}

export interface MatchedOrdersRestGates {
  requirePrincipal(req: FastifyRequest, reply: FastifyReply): Principal | null;
  requireTradeJurisdiction(req: FastifyRequest, reply: FastifyReply, principal: Principal): boolean;
  regionOf(req: FastifyRequest): string | null | undefined;
  /** The service's shared domain mapping (auth, CCXT); null when it does not know the error. */
  sendDomainError(reply: FastifyReply, err: unknown): FastifyReply | null;
}

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
    },
  };
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
      const order = await deps.place(principal, read.input, { region: gates.regionOf(req) ?? null });
      return reply.code(200).send(order);
    } catch (err) {
      const sent = sendFuturesFailure(reply, err, gates);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Querystring: { scope?: string; limit?: string; symbol?: string } }>('/api/v1/futures/orders', async (req, reply) => {
    const principal = gates.requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.list) return reply.code(503).send(UNMOUNTED);
    const scope = req.query.scope;
    if (scope !== 'open' && scope !== 'all') return bad(reply, 'trade.futures_orders_scope_invalid', 'scope must be open or all');
    const limitRaw = typeof req.query.limit === 'string' ? req.query.limit.trim() : '';
    const limit = /^\d+$/.test(limitRaw) ? Number(limitRaw) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > FUTURES_ORDERS_LIMIT_MAX) {
      return bad(reply, 'trade.futures_orders_limit_unset', `limit is required, 1–${FUTURES_ORDERS_LIMIT_MAX} — refuse to invent one`);
    }
    try {
      requireScope(principal, 'trade:read');
      const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim() !== '' ? req.query.symbol.trim() : null;
      return reply.code(200).send(await deps.list(principal, { scope, limit, symbol }));
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
