import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { carriedPlacementBody } from './placement-extras.js';

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

export const AUCTION_UNSUPPORTED = 'auction_unsupported' as const;
export const BENCHMARK_UNSUPPORTED = 'benchmark_unsupported' as const;

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

/** What this request's own body asks for; null when it asks for nothing. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): { auction: boolean | null; benchmark: boolean | null } | null {
  if (!body || !wantsAuctionIntent(body)) return null;
  return {
    auction: body.auction === undefined ? null : flagFromRaw(body.auction),
    benchmark: body.benchmark === undefined ? null : flagFromRaw(body.benchmark),
  };
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
  const hit = stashedFor(carriedPlacementBody(extra));
  if (!hit) return extra;
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
