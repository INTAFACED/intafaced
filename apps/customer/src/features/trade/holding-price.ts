import { useLayoutEffect, useSyncExternalStore } from 'react';
import { navigate } from '../../app/location';
import type { ApiClient } from '../../shared/api';
import { decimalSchema, parseAmount } from '../../shared/money';
import type { Resource } from '../../shared/resource';
import { currentSharedCardRoute, subscribeSharedCardRoute } from '../more/blueprint-shared-card-contract';
import type { Listing } from './trade-api';

type Route = ReturnType<typeof currentSharedCardRoute>;
export type HoldingPrice = Readonly<{ price: string; symbol: string; base: string; quote: string }>;
type Intent = {
  value: HoldingPrice;
  transport: ApiClient;
  owner: string;
  target: string;
  rules: string;
  route: Route;
  hopping: boolean;
};
type Retired = { transport: ApiClient; owner: string; target: string };
let pending: Intent | undefined;
let retired: Retired | undefined;
let releaseRoute: (() => void) | undefined;
let snapshot = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish() {
  snapshot = {};
  for (const listener of listeners) listener();
}
function finish(intent: Intent, refused: boolean) {
  if (pending !== intent) return;
  pending = undefined;
  retired = refused ? { transport: intent.transport, owner: intent.owner, target: intent.target } : undefined;
  releaseRoute?.();
  releaseRoute = undefined;
  publish();
}
function rules(market: Listing) {
  return JSON.stringify([
    market.id,
    market.symbol,
    market.base,
    market.quote,
    market.baseId,
    market.quoteId,
    market.type,
    market.spot,
    market.paper,
    market.contract,
    market.active,
    market.orderable,
    market.precisionMode,
    market.precision.price,
    market.precision.amount,
    market.limits.price.min,
    market.limits.price.max,
  ]);
}
function eligible(market: Listing, price: string) {
  if (!market.spot || market.paper || market.type !== 'spot' || market.contract || !market.active || !market.orderable) return false;
  try {
    if (!decimalSchema.safeParse(price).success) return false;
    const value = parseAmount(price),
      tick = parseAmount(market.precision.price);
    return (
      value > 0n &&
      tick > 0n &&
      value % tick === 0n &&
      (market.limits.price.min === null || value >= parseAmount(market.limits.price.min)) &&
      (market.limits.price.max === null || value <= parseAmount(market.limits.price.max))
    );
  } catch {
    return false;
  }
}
function matching(intent: Intent, markets: Listing[]) {
  const matches = markets.filter((market) => market.symbol === intent.value.symbol);
  return matches.length === 1 && rules(matches[0]!) === intent.rules && eligible(matches[0]!, intent.value.price);
}
function current(intent: Intent, transport: ApiClient, owner: string | null) {
  return (
    pending === intent &&
    !intent.hopping &&
    intent.transport === transport &&
    intent.owner === owner &&
    transport.canWrite() &&
    currentSharedCardRoute() === intent.route &&
    intent.route.href === intent.target
  );
}

/** Owns the single same-document hop. Private prices never enter the URL or
 * durable storage. After the hop, admission no longer depends on source mount. */
export function stageHoldingPrice(
  transport: ApiClient,
  owner: string | null,
  market: Listing,
  price: string,
  sourceCurrent: () => boolean,
) {
  // The existing exact pair route uppercases symbols. Do not retarget a wire
  // symbol which cannot round-trip through that route.
  if (
    !owner ||
    !transport.canWrite() ||
    !sourceCurrent() ||
    market.symbol !== market.symbol.toUpperCase() ||
    !market.symbol.includes('/') ||
    !eligible(market, price)
  )
    return false;
  if (pending) finish(pending, false);
  const target = new URL(`/exchange/${encodeURIComponent(market.symbol)}`, location.origin).href;
  const intent: Intent = {
    value: Object.freeze({ price, symbol: market.symbol, base: market.base, quote: market.quote }),
    transport,
    owner,
    target,
    rules: rules(market),
    route: currentSharedCardRoute(),
    hopping: true,
  };
  retired = undefined;
  pending = intent;
  releaseRoute = subscribeSharedCardRoute(() => {
    if (pending !== intent) return;
    const route = currentSharedCardRoute();
    if (intent.hopping && route.href === target && transport.canWrite()) {
      intent.route = route;
      intent.hopping = false;
    } else if (route !== intent.route || !transport.canWrite()) finish(intent, true);
  });
  publish();
  try {
    if (!sourceCurrent() || !transport.canWrite()) {
      finish(intent, true);
      return false;
    }
    navigate(new URL(target).pathname);
    if (!current(intent, transport, owner)) {
      finish(intent, true);
      return false;
    }
    return true;
  } catch {
    finish(intent, true);
    return false;
  }
}

/** Current catalogue failure can be retried. Successful mismatch and any
 * observed departure retire the exact intent. Consumption happens in the
 * ticket's layout effect, never render, and never blanks a later manual draft. */
export function useHoldingPrice(transport: ApiClient, owner: string | null, catalogue: Resource<Listing[]>) {
  useSyncExternalStore(subscribe, () => snapshot);
  const route = useSyncExternalStore(subscribeSharedCardRoute, currentSharedCardRoute);
  const intent = pending;
  const admitted = intent && current(intent, transport, owner);
  const matches = admitted && catalogue.status === 'ready' && matching(intent, catalogue.data);
  useLayoutEffect(() => {
    if (intent && (!admitted || (catalogue.status === 'ready' && !matches))) finish(intent, true);
  }, [intent, admitted, matches, catalogue, route]);
  if (admitted && (catalogue.status !== 'ready' || matches)) {
    return {
      status: matches ? ('ready' as const) : ('waiting' as const),
      value: intent.value,
      retire() {
        finish(intent, true);
      },
      take(market: Listing): HoldingPrice | undefined {
        if (
          catalogue.status !== 'ready' ||
          !current(intent, transport, owner) ||
          !matching(intent, catalogue.data) ||
          rules(market) !== intent.rules
        )
          return;
        const value = intent.value;
        finish(intent, false);
        return value;
      },
    };
  }
  if (
    (admitted && catalogue.status === 'ready' && !matches) ||
    (retired?.transport === transport && retired.owner === owner && retired.target === route.href && transport.canWrite())
  ) {
    return { status: 'retired' as const };
  }
  return undefined;
}
