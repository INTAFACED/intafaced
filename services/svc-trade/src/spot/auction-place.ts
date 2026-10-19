import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { attachStashRelease, stashSet } from './stash-scope.js';

/**
 * Place auction / benchmark through the matching door that landed in #3321.
 * Unsupported intent refuses rather than becoming a silent limit.
 * Missing or false is a normal place. Trade does not invent an auction price.
 */

type PlaceWithAuction = PlaceOrderInput & {
  auction?: boolean | null;
  benchmark?: boolean | null;
};

const FLAG = Symbol.for('intafaced.trade.auctionPlace');
const stash = new Map<string, { auction: boolean | null; benchmark: boolean | null }>();

export const AUCTION_UNSUPPORTED = 'auction_unsupported' as const;
export const BENCHMARK_UNSUPPORTED = 'benchmark_unsupported' as const;

function stashKey(rec: Record<string, unknown>): string {
  const client = rec.clientOrderId;
  if (typeof client === 'string' && client.length > 0) return client;
  return `__auction:${String(rec.symbol ?? '')}:${String(rec.side ?? '')}:${String(rec.type ?? '')}:${String(rec.amount ?? rec.qty ?? '')}:${String(rec.price ?? '')}`;
}

function wantsAuctionIntent(rec: Record<string, unknown>): boolean {
  return rec.auction !== undefined || rec.benchmark !== undefined;
}

function flagFromRaw(value: unknown): boolean | null {
  if (value === true) return true;
  if (value == null) return null;
  return Boolean(value);
}

/** Caller auction. Missing, null, or false is not set. */
export function readAuction(order: { readonly auction?: boolean | null }): boolean {
  return order.auction === true;
}

export function readBenchmark(order: { readonly benchmark?: boolean | null }): boolean {
  return order.benchmark === true;
}

export function auctionRefuse(auction: boolean): TradeError | null {
  if (!auction) return null;
  return new TradeError('auction orders are unsupported; trade does not invent an auction price', 'trade.auction_unsupported');
}

export function benchmarkRefuse(benchmark: boolean): TradeError | null {
  if (!benchmark) return null;
  return new TradeError('benchmark orders are unsupported; trade does not invent a benchmark price', 'trade.benchmark_unsupported');
}

/** Matching's auction then benchmark. Trade wraps those codes. */
export function auctionIntentRefuse(order: { readonly auction?: boolean | null; readonly benchmark?: boolean | null }): TradeError | null {
  return auctionRefuse(readAuction(order)) ?? benchmarkRefuse(readBenchmark(order));
}

export function attachAuctionStash(app: FastifyInstance): void {
  attachStashRelease(app);
  app.addHook('preValidation', (req, _reply, done) => {
    const body = req.body;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (wantsAuctionIntent(rec)) {
        stashSet(req, stash, stashKey(rec), {
          auction: rec.auction === undefined ? null : flagFromRaw(rec.auction),
          benchmark: rec.benchmark === undefined ? null : flagFromRaw(rec.benchmark),
        });
      }
    }
    done();
  });
}

export function bindAuction(input: PlaceOrderInput): PlaceWithAuction {
  const extra = input as PlaceWithAuction;
  if (wantsAuctionIntent(extra as unknown as Record<string, unknown>)) {
    return {
      ...extra,
      auction: extra.auction ?? null,
      benchmark: extra.benchmark ?? null,
    };
  }
  const rec = extra as unknown as Record<string, unknown>;
  const key = stashKey({
    clientOrderId: extra.clientOrderId,
    symbol: rec.symbol,
    side: extra.side,
    type: extra.type,
    amount: rec.amount,
    qty: rec.qty,
    price: extra.price,
  });
  const hit = stash.get(key);
  if (!hit) return extra;
  stash.delete(key);
  return { ...extra, auction: hit.auction, benchmark: hit.benchmark };
}

export function installAuctionPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindAuction(input);
    const refuse = auctionIntentRefuse(bound);
    if (refuse) throw refuse;
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithAuction | undefined;
    if (!input) return req;
    const auction = readAuction(input);
    const benchmark = readBenchmark(input);
    if (!auction && !benchmark) return req;
    return {
      ...req,
      ...(auction ? { auction: true } : {}),
      ...(benchmark ? { benchmark: true } : {}),
    };
  };
}

installAuctionPlace(TradeService);
