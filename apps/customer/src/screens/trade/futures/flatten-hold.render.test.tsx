// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VenueMarket, VenuePosition } from '../../../features/trade/venue-api';
import { FlattenHold } from './VenueFuturesDesk';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../features/trade/venue/VenueKit', async (original) => {
  const real = await original<typeof import('../../../features/trade/venue/VenueKit')>();
  return {
    ...real,
    useVenueApi: () => ({
      bestPrices: () =>
        Promise.resolve({
          ok: true,
          data: {
            asOf: '2026-11-25T00:00:00Z',
            value: { symbol: 'BTC-PERP', bid: '60000', ask: '60001' },
            slippageCapBps: { known: true, value: '50' },
          },
        }),
    }),
  };
});

const market = (symbol: string) => ({ symbol, orderTypes: ['market', 'limit'], tickSize: '0.1', lotSize: '0.001' }) as VenueMarket;
const position = (symbol: string, side: 'long' | 'short', size: string) =>
  ({ symbol, side, size, entryPrice: '59000', markPrice: '60000', unrealisedPnl: '10' }) as VenuePosition;
const OWNER = '0x1111111111111111111111111111111111111111';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const button = () => host.querySelector<HTMLButtonElement>('[data-testid="venue-flatten"] button')!;
const press = (type: string) => act(() => void button().dispatchEvent(new PointerEvent(type, { bubbles: true })));

describe('Flatten (desk A)', () => {
  it('sends nothing when let go before 0.65 s', async () => {
    const run = vi.fn();
    act(() =>
      root.render(
        <FlattenHold
          positions={[position('BTC-PERP', 'long', '0.5')]}
          markets={[market('BTC-PERP')]}
          owner={OWNER}
          run={run}
          closeSlippageBps={1000}
        />,
      ),
    );
    press('pointerdown');
    await act(async () => void vi.advanceTimersByTime(600));
    press('pointerup');
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(run).not.toHaveBeenCalled();
  });

  it('after a full hold closes every position whole, reduce-only at the market, under one business key each', async () => {
    const run = vi.fn().mockResolvedValue({ kind: 'refused', code: 'trade.test', message: 'TEST refused', beforeWallet: true });
    const positions = [position('BTC-PERP', 'long', '0.5'), position('ETH-PERP', 'short', '2')];
    act(() =>
      root.render(
        <FlattenHold
          positions={positions}
          markets={[market('BTC-PERP'), market('ETH-PERP')]}
          owner={OWNER}
          run={run}
          closeSlippageBps={1000}
        />,
      ),
    );
    press('pointerdown');
    await act(async () => void (await vi.advanceTimersByTimeAsync(650)));
    expect(run).toHaveBeenCalledTimes(2);
    const [btc, eth] = run.mock.calls.map((c) => c[0]);
    expect(btc).toMatchObject({
      kind: 'place_order',
      symbol: 'BTC-PERP',
      side: 'sell',
      type: 'market',
      amount: '0.5',
      // The owner's close tolerance (10% here, status `closeSlippageBps`) from the best price the close meets.
      price: '54000',
      reduceOnly: true,
      timeInForce: 'IOC',
    });
    // 66001.1 has 6 significant figures, which the venue refuses: a buy's cap rounds down to 5.
    expect(eth).toMatchObject({ symbol: 'ETH-PERP', side: 'buy', amount: '2', price: '66001', reduceOnly: true });
    expect(btc.clientOrderKey).toMatch(/^close:/);
    expect(btc.clientOrderKey).not.toBe(eth.clientOrderKey);
  });

  it('after a lost answer, a second hold re-sends the same close, never a new one', async () => {
    const run = vi.fn().mockResolvedValue({ kind: 'unknown', clientOrderId: null, nonce: null });
    act(() =>
      root.render(
        <FlattenHold
          positions={[position('BTC-PERP', 'long', '0.5')]}
          markets={[market('BTC-PERP')]}
          owner={OWNER}
          run={run}
          closeSlippageBps={1000}
        />,
      ),
    );
    for (let i = 0; i < 2; i++) {
      press('pointerdown');
      await act(async () => void (await vi.advanceTimersByTimeAsync(650)));
      press('pointerup');
    }
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![0].clientOrderKey).toBe(run.mock.calls[1]![0].clientOrderKey);
  });

  it('is not shown with no position open', () => {
    act(() =>
      root.render(<FlattenHold positions={[]} markets={[market('BTC-PERP')]} owner={OWNER} run={vi.fn()} closeSlippageBps={1000} />),
    );
    expect(host.querySelector('[data-testid="venue-flatten"]')).toBeNull();
  });
});
