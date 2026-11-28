/**
 * Applies layers to a class, first to last: `layered(TradeService, withA, withB)` is `withB(withA(TradeService))`, so a
 * later layer's `super.placeOrder(…)` reaches the earlier ones. A layer is a function from the class to a subclass
 * (spot/fok-place.ts `withFokPlace`). The layers are applied where the service is put together at start-up (index.ts),
 * never by importing a module (garden/no-runtime-swap; docs/agents/shape.md rule 5).
 */
export function layered<C>(base: C, ...layers: ReadonlyArray<(c: C) => C>): C {
  return layers.reduce((c, layer) => layer(c), base);
}
