/**
 * Unit card — tRPC does not invent a second futures money door
 * 1. Promise: positions / live leverage / funding ticks stay REST-only
 * 2. Break: tRPC grows openPosition/setLeverage that skip REST refuses
 * 3. Done bar: router.ts has no positions procedure and no setLeverage
 * 4. Class N
 * 5. Paths: svc-trade/src/router.ts
 * 6. RED: router({ positions: or setLeverage:
 * 7. Collision: #1903 planner MM; #1881 D3 skip
 */

import { describe, expect, it } from 'vitest';
import { tradeRouterPaths } from './__tests__/entry.js';

describe('tRPC does not grow a second futures money door', () => {
  it('does not mount positions, setLeverage, or a funding-rate procedure', () => {
    const futuresShaped = tradeRouterPaths().filter((path) =>
      path.split('.').some((part) => /^(positions|setLeverage|fundingRate|openPosition|closePosition)$/.test(part)),
    );
    // The only ones are reads that move nothing: the console's position list and the options positions view.
    expect(futuresShaped).toEqual(['admin.positions.get', 'admin.positions.list', 'options.positions']);
  });

  it('still mounts the spot order door so the pin is not vacuous', () => {
    expect(tradeRouterPaths()).toEqual(expect.arrayContaining(['orders.create', 'orders.cancel', 'orders.open']));
  });
});
