// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolRouteOptions, ProtocolSwapToken } from '@intafaced/contracts/protocol-swap';
import { RouteOptions } from './RouteOptions';

// TEST figures only: shaped like a route read, not any network's live pools.
const B: ProtocolSwapToken = { address: '0x00000000000000000000000000000000000000b0', name: 'TEST Token B', symbol: 'TB', decimals: 18 };
const POOL = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const quote = (amountOut: string, priceImpactBps: number, feeBps: number) => ({
  amountOut,
  priceImpactBps,
  reserveIn: '1000000000000000000000000',
  reserveOut: '1000000000000000000000000',
  feeBps,
  reservesFromChain: true as const,
  blockTimestampLast: 1,
});
const ROUTES: ProtocolRouteOptions = {
  venue: 'pool',
  blockNumber: '120',
  tokenIn: '0x00000000000000000000000000000000000000a0',
  tokenOut: B.address,
  amountIn: '10000000000000000000',
  legs: [
    { pool: POOL(1), feeBps: 30, quote: quote('9969900000000000000', 1, 30), status: 'best', shortfall: null, reason: null },
    {
      pool: POOL(2),
      feeBps: 100,
      quote: quote('9898000000000000000', 20, 100),
      status: 'lost',
      shortfall: '71900000000000000',
      reason: null,
    },
    { pool: POOL(3), feeBps: 50, quote: null, status: 'unavailable', shortfall: null, reason: 'stale' },
    { pool: POOL(4), feeBps: 30, quote: null, status: 'unavailable', shortfall: null, reason: 'no_liquidity' },
    { pool: POOL(5), feeBps: 30, quote: null, status: 'unavailable', shortfall: null, reason: 'unreadable' },
  ],
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (routes: ProtocolRouteOptions, excluded: string[] = [], onExclude = vi.fn()) => {
  await act(async () => root.render(<RouteOptions routes={routes} tokenOut={B} excluded={excluded} onExclude={onExclude} />));
  return onExclude;
};
const rows = () => [...host.querySelectorAll('tbody tr')] as HTMLTableRowElement[];

describe('Route options', () => {
  it('lists every leg in the service order, best first, with why each other leg lost or cannot be used', async () => {
    await render(ROUTES);
    expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Routes');
    expect(rows()).toHaveLength(5);
    expect(rows()[0]!.textContent).toContain('Best');
    expect(rows()[0]!.textContent).toContain('9.9699 TEST Token B');
    expect(rows()[1]!.textContent).toContain('Lost: 0.0719 TEST Token B less than the best');
    expect(rows()[2]!.textContent).toContain('unavailable: stale');
    expect(rows()[2]!.textContent).toContain('—');
    expect(rows()[3]!.textContent).toContain('unavailable: no liquidity');
    expect(rows()[4]!.textContent).toContain('unavailable: the network did not answer for this pool');
    expect(host.textContent).toContain('at block 120');
  });

  it('ticks an excluded pool and reports each change by pool', async () => {
    const onExclude = await render(ROUTES, [POOL(1).toUpperCase().replace('0X', '0x')]);
    const boxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false, false, false]);
    await act(async () => boxes[1]!.click());
    expect(onExclude).toHaveBeenCalledWith(POOL(2), true);
    await act(async () => boxes[0]!.click());
    expect(onExclude).toHaveBeenCalledWith(POOL(1), false);
  });

  it('marks an excluded leg "Excluded" and gives no shortfall for it', async () => {
    const legs = ROUTES.legs.map((leg, index) =>
      index === 0 ? { ...leg, status: 'excluded' as const } : index === 1 ? { ...leg, status: 'best' as const, shortfall: null } : leg,
    );
    await render({ ...ROUTES, legs }, [POOL(1)]);
    expect(rows()[0]!.textContent).toContain('Excluded');
    expect(rows()[1]!.textContent).toContain('Best');
  });
});
