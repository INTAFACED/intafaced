/**
 * POST /internal/buyback/ioc-buy — the token buyback's one IOC limit buy (J-dex-protocol-17).
 *
 * Service auth (S2S v3 keys, or the shared secret while dual), and only svc-token may call it. The body carries
 * decimal strings; nothing here invents a price, a size or a budget. svc-token has already swept what it will spend
 * into the rewards engine, and the hold is refused there if it has not.
 *
 * Body: { symbol, qty, price, clientOrderId }. `clientOrderId` is svc-token's run id: a retry with the same id and the
 * same command returns the first order, a different command is `trade.buyback_conflict`.
 *
 * 200: { orderId, status, filledQty, heldQuote, spentQuote, releasedQuote }, all amounts as decimal strings.
 * `releasedQuote` is what went back to the rewards engine; it is "0" until the order is terminal.
 */
import type { FastifyInstance } from 'fastify';
import { retainRawBody, verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { formatAmount, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import { toCcxtError } from '../ccxt-errors.js';
import { BUYBACK_CALLER, BUYBACK_INVALID } from './buyback-order.js';
import type { BuybackIocBuyInput, BuybackIocBuyResult } from './trade-service/buyback.js';

export const BUYBACK_IOC_BUY_PATH = '/internal/buyback/ioc-buy';

export interface BuybackDoorDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly placeBuybackIocBuy: (input: BuybackIocBuyInput) => Promise<BuybackIocBuyResult>;
  /** Isolated tests install retention; production index already called `retainRawBody`. */
  readonly installRawBody?: boolean;
}

const POSITIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function positiveAmount(value: unknown): Amount | null {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL.test(value)) return null;
  try {
    const amount = parseAmount(value);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

export function parseBuybackBody(body: unknown): BuybackIocBuyInput | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { symbol, qty, price, clientOrderId } = body as Record<string, unknown>;
  if (typeof symbol !== 'string' || symbol.length === 0 || symbol.trim() !== symbol) return null;
  if (
    typeof clientOrderId !== 'string' ||
    clientOrderId.length === 0 ||
    clientOrderId.length > 64 ||
    clientOrderId.trim() !== clientOrderId
  ) {
    return null;
  }
  const q = positiveAmount(qty);
  const p = positiveAmount(price);
  if (q === null || p === null) return null;
  return { symbol, qty: q, price: p, clientOrderId };
}

const TERMINAL = new Set(['filled', 'cancelled', 'rejected', 'expired']);

export function registerBuybackDoor(app: FastifyInstance, deps: BuybackDoorDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post(BUYBACK_IOC_BUY_PATH, async (req, reply) => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) {
      return reply.code(401).send({ error: 'unauthorized', code: 'auth.required', message: 'service auth required' });
    }
    if (verified.service !== BUYBACK_CALLER) {
      return reply
        .code(403)
        .send({ error: 'forbidden', code: 'trade.buyback_forbidden', message: 'the buyback buy is for the token service only' });
    }
    const input = parseBuybackBody(req.body);
    if (!input) {
      return reply.code(400).send({
        error: 'bad_request',
        code: BUYBACK_INVALID,
        message: 'symbol, clientOrderId (1–64 chars) and positive decimal-string qty and price are required',
      });
    }
    try {
      const result = await deps.placeBuybackIocBuy(input);
      const released = TERMINAL.has(result.status) ? sub(result.held, result.spent) : 0n;
      return {
        orderId: result.orderId,
        status: result.status,
        filledQty: formatAmount(result.filledQty),
        heldQuote: formatAmount(result.held),
        spentQuote: formatAmount(result.spent),
        releasedQuote: formatAmount(released),
      };
    } catch (err) {
      const mapped = toCcxtError(err);
      if (!mapped) throw err;
      return reply.code(mapped.status).send({ error: mapped.body.code, code: mapped.body.intafacedCode, message: mapped.body.message });
    }
  });
}
