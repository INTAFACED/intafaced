/**
 * SUPPORT READ OF ONE ORDER (SUP-0007; J-support-public-20 #1): `GET /internal/orders/:id`, the route svc-support's
 * client already calls (`services/svc-support/src/ticket-order.ts`). svc-support compares the order's owner with the
 * ticket's customer, so a ticket links only that customer's orders, and a `recovery_required` order ranks first.
 *
 * Read only: it never cancels, amends or posts. Only svc-support may call it. An id with no order is 404, and a read
 * that fails is 503 (`matcher_down`), never an invented order. Amounts are decimal strings. An order whose fills charged
 * fees in more than one asset answers 409 with its owner and status but no fee figure, because one figure would mix them.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';

// Any well-formed id is looked up, so an id with no order answers 404 the same as svc-support's own id check expects.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A decimal string with no trailing zeros, as the support wire rule wants it. */
const decimal = (value: string): string => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

export interface SupportOrderView {
  orderId: string;
  userId: string;
  status: string;
  symbol: string;
  side: 'buy' | 'sell';
  filledQuantity: string;
  feeAsset: string;
  feeAmount: string;
}

export type SupportOrderReadOutcome =
  | { kind: 'order'; order: SupportOrderView }
  | { kind: 'missing' }
  | { kind: 'fee_mixed'; owner: { orderId: string; userId: string; status: string } };

export async function readSupportOrder(sql: Sql, orderId: string): Promise<SupportOrderReadOutcome> {
  const rows = await sql<
    Array<{ id: string; user_id: string; status: string; symbol: string; side: 'buy' | 'sell'; filled_qty: string; quote_asset: string }>
  >`
    SELECT o.id, o.user_id, o.status::text AS status, m.symbol, o.side::text AS side, o.filled_qty::text AS filled_qty, m.quote_asset
      FROM trade.orders o JOIN trade.markets m ON m.id = o.market_id
     WHERE o.id = ${orderId}
  `;
  const order = rows[0];
  if (!order) return { kind: 'missing' };
  const fees = await sql<Array<{ fee_asset: string; fee: string }>>`
    SELECT fee_asset, sum(fee_amount)::text AS fee FROM trade.fills WHERE order_id = ${orderId} GROUP BY fee_asset
  `;
  if (fees.length > 1) return { kind: 'fee_mixed', owner: { orderId: order.id, userId: order.user_id, status: order.status } };
  return {
    kind: 'order',
    order: {
      orderId: order.id,
      userId: order.user_id,
      status: order.status,
      symbol: order.symbol,
      side: order.side,
      filledQuantity: decimal(order.filled_qty),
      feeAsset: fees[0]?.fee_asset ?? order.quote_asset,
      feeAmount: decimal(fees[0]?.fee ?? '0'),
    },
  };
}

export function registerSupportOrderRead(
  app: FastifyInstance,
  deps: {
    read: (orderId: string) => Promise<SupportOrderReadOutcome>;
    secret: string;
    s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode };
  },
): void {
  app.get<{ Params: { id: string } }>('/internal/orders/:id', async (req, reply) => {
    let caller: string | null = null;
    try {
      caller =
        typeof deps.secret === 'string' && deps.secret.length > 0
          ? verifyServiceRequest(req, {
              verifier: deps.s2s?.verifier,
              mode: deps.s2s?.mode,
              legacySecret: deps.secret,
              bodyBindMode: 'require',
            }).service
          : null;
    } catch {
      caller = null;
    }
    if (caller === null) return reply.code(401).send({ error: 'service credentials required', code: 'trade.unauthenticated' });
    if (caller !== 'svc-support')
      return reply.code(403).send({ error: 'this order read is for the support service only', code: 'trade.order_read_forbidden' });
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'order id is invalid', code: 'trade.order_read_input' });
    try {
      const read = await deps.read(req.params.id.toLowerCase());
      if (read.kind === 'missing') return reply.code(404).send({ error: 'no such order', code: 'trade.order_not_found' });
      if (read.kind === 'fee_mixed')
        return reply.code(409).send({ error: 'fees were charged in more than one asset', code: 'trade.order_fee_mixed', ...read.owner });
      return read.order;
    } catch {
      return reply.code(503).send({ error: 'order read unavailable', code: 'matcher_down' });
    }
  });
}
