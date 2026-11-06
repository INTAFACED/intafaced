/**
 * The convert API (J-cex-spot-11 #12, SP-convert-buy-03): the same `TradeService` convert calls the Convert room's
 * `convert.*` doors make, so a key gets the room's rules, codes and idempotency.
 *
 *   POST /api/v1/convert/quote   scope: trade:write (every POST door is a write)   body { from, to, amount }: a firm
 *                                price for `amount` of `from`
 *   POST /api/v1/convert/accept  scope: trade:write + jurisdiction(module=trade)   body { quoteId, clientConvertId? }
 *
 * A quote holds nothing: no ledger entry is posted until the accept. The accept settles the quote once: the settle's
 * ledger keys are the quote's own, so the same quote id sent again (in a row or at once) answers the one conversion it
 * made and moves nothing more. Two calls for one quote on this instance also wait on each other, so the second reads
 * the first's settled conversion rather than racing its admission. Refusals use the shared CCXT mapping, with the
 * service's code in `intafacedCode`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { invalidOrder, toCcxtError } from '../ccxt-errors.js';
import { privateWrite } from '../route-inventory.js';
import { TradeError } from '../spot/types.js';
import type { TradeService } from '../spot/trade-service.js';

export type ConvertRestPort = Pick<TradeService, 'convertRoute' | 'convertQuote' | 'convertAccept'>;

export interface ConvertRestDeps {
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null;
  requireTradeJurisdiction: (req: FastifyRequest, reply: FastifyReply, principal: Principal) => boolean;
}

const asset = z.string().regex(/^[A-Z0-9]{2,12}$/, 'an asset code such as USDT');
const quoteBody = z.object({
  from: asset,
  to: asset,
  amount: z.string().regex(/^\d+(\.\d{1,18})?$/, 'an unsigned decimal string with at most 18 decimal places'),
});
const acceptBody = z.object({
  quoteId: z.string().min(1).max(64),
  clientConvertId: z.string().min(1).max(48).optional(),
});

function refuse(reply: FastifyReply, error: unknown) {
  const mapped = toCcxtError(error);
  if (!mapped) throw error;
  const data = error instanceof TradeError ? error.data : undefined;
  return reply.code(mapped.status).send({ ...mapped.body, ...(data ? { data } : {}) });
}

function malformed(reply: FastifyReply, issues: z.ZodIssue[]) {
  const issue = issues[0];
  const res = invalidOrder(
    `The convert request is malformed: ${issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid'}`,
  );
  return reply.code(res.status).send(res.body);
}

export function attachConvertRestRoutes(app: FastifyInstance, convert: ConvertRestPort | undefined, deps: ConvertRestDeps): void {
  /** One accept per user and quote at a time on this instance; the second waits, then replays the settled conversion. */
  const inFlight = new Map<string, Promise<unknown>>();

  function admit(req: FastifyRequest, reply: FastifyReply, scope: Scope): Principal | null {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return null;
    try {
      requireScope(principal, scope);
    } catch (error) {
      refuse(reply, error);
      return null;
    }
    if (scope === 'trade:write' && !deps.requireTradeJurisdiction(req, reply, principal)) return null;
    return principal;
  }

  function unmounted(reply: FastifyReply) {
    return reply
      .code(503)
      .send({ code: 'ExchangeNotAvailable', message: 'convert is not mounted', intafacedCode: 'trade.convert_unmounted' });
  }

  app.post('/api/v1/convert/quote', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    if (!convert) return unmounted(reply);
    const parsed = quoteBody.safeParse(req.body ?? {});
    if (!parsed.success) return malformed(reply, parsed.error.issues);
    try {
      const { from, to, amount } = parsed.data;
      const route = await convert.convertRoute(principal, { from, to });
      // Paying with the quote asset is a buy sized to the spend; paying with the coin is a sell of that amount.
      const quote = await convert.convertQuote(principal, {
        symbol: route.symbol,
        side: route.side,
        ...(route.side === 'buy' ? { quoteQty: parseAmount(amount) } : { qty: parseAmount(amount) }),
      });
      return reply.code(200).send({
        quoteId: quote.quoteId,
        symbol: quote.symbol,
        fromAsset: quote.inAsset,
        toAsset: quote.outAsset,
        fromAmount: quote.inAmount,
        toAmount: quote.outAmount,
        price: quote.avgPrice,
        spreadBps: quote.convertSpreadBps,
        expiresAt: quote.expiresAt,
        held: false,
      });
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post('/api/v1/convert/accept', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    if (!convert) return unmounted(reply);
    const parsed = acceptBody.safeParse(req.body ?? {});
    if (!parsed.success) return malformed(reply, parsed.error.issues);
    const key = `${principal.userId}:${parsed.data.quoteId}`;
    const before = inFlight.get(key);
    const run = (async () => {
      if (before) await before.catch(() => undefined);
      return convert.convertAccept(principal, { quoteId: parsed.data.quoteId, clientConvertId: parsed.data.clientConvertId });
    })();
    inFlight.set(key, run);
    try {
      const fill = await run;
      return reply.code(200).send({
        quoteId: fill.quoteId,
        fillId: fill.fillId,
        symbol: fill.symbol,
        fromAsset: fill.inAsset,
        toAsset: fill.outAsset,
        fromAmount: fill.inAmount,
        toAmount: fill.outAmount,
        price: fill.fillPrice,
        spreadBps: fill.convertSpreadBps,
        settledAt: fill.settledAt,
      });
    } catch (error) {
      return refuse(reply, error);
    } finally {
      if (inFlight.get(key) === run) inFlight.delete(key);
    }
  });
}
