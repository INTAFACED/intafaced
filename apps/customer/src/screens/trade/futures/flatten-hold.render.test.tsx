// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VenueIntent, VenueMarket, VenueOrder, VenuePosition } from '../../../features/trade/venue-api';
import type { ActionResult, RunAction } from '../../../features/trade/venue/VenueKit';
import { FlattenHold } from './VenueFlatten';
import { closeWorstPrice } from './VenueFuturesDesk';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// J-derivatives-33: the venue's account reads, set per test. Each read answers what the venue holds at that moment.
const venueReads = vi.hoisted(() => ({
  positions: [] as unknown[],
  orders: [] as unknown[],
  byClientId: null as unknown,
  asOf: '2026-11-28T05:00:00.000Z',
}));
vi.mock('../../../features/trade/venue/VenueKit', async (original) => {
  const real = await original<typeof import('../../../features/trade/venue/VenueKit')>();
  return {
    ...real,
    useVenueApi: () => ({
      positions: () => Promise.resolve({ ok: true, data: { asOf: venueReads.asOf, value: venueReads.positions } }),
      openOrders: () => Promise.resolve({ ok: true, data: { asOf: venueReads.asOf, value: venueReads.orders } }),
      orderByClientId: () => Promise.resolve({ ok: true, data: { asOf: venueReads.asOf, value: venueReads.byClientId } }),
    }),
  };
});

const market = (symbol: string) => ({ symbol, orderTypes: ['market', 'limit'], tickSize: '0.1', lotSize: '0.001' }) as VenueMarket;
const position = (symbol: string, side: 'long' | 'short', size: string) =>
  ({ symbol, side, size, entryPrice: '59000', markPrice: '60000', unrealisedPnl: '10' }) as VenuePosition;
const order = (symbol: string, id: string) =>
  ({ symbol, venueClientOrderId: id, side: 'buy', price: '50000', amount: '0.1', remaining: '0.1', status: 'open' }) as VenueOrder;
const OWNER = '0x1111111111111111111111111111111111111111';
const symbolOf = (intent: VenueIntent) => ('symbol' in intent ? intent.symbol : null);
const keyOf = (intent: VenueIntent) => (intent.kind === 'place_order' ? intent.clientOrderKey : null);
const filled: ActionResult = {
  kind: 'outcome',
  reused: false,
  clientOrderId: '0xc',
  nonce: '1',
  outcome: { definite: true, accepted: true, venueRef: null, order: { status: 'filled' }, asOf: new Date() } as never,
};
const cancelled: ActionResult = {
  ...filled,
  outcome: {
    definite: true,
    accepted: true,
    venueRef: null,
    order: null,
    legs: [{ definite: true, accepted: true }],
    asOf: new Date(),
  } as never,
};
const refused = (detail: string): ActionResult => ({
  kind: 'outcome',
  reused: false,
  clientOrderId: '0xc',
  nonce: '1',
  outcome: { definite: true, accepted: false, refusal: { venueId: 'v', code: 'venue_rejected', detail }, asOf: new Date() } as never,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  venueReads.positions = [];
  venueReads.orders = [];
  venueReads.byClientId = null;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const button = () => host.querySelector<HTMLButtonElement>('[data-testid="venue-flatten"] button')!;
const press = (type: string) => act(() => void button().dispatchEvent(new PointerEvent(type, { bubbles: true })));
const hold = async () => {
  press('pointerdown');
  await act(async () => void (await vi.advanceTimersByTimeAsync(650)));
  press('pointerup');
  await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
};
const verdict = () => host.querySelector('[data-testid="venue-flatten-verdict"]');
const lines = () => [...host.querySelectorAll('[data-testid="venue-flatten-legs"] li')];

function render(run: RunAction, positions: VenuePosition[], orders: VenueOrder[] = [], onSettled = vi.fn()) {
  venueReads.positions = positions;
  venueReads.orders = orders;
  act(() =>
    root.render(
      <FlattenHold
        positions={positions}
        orders={orders}
        markets={[market('BTC-PERP'), market('ETH-PERP'), market('SOL-PERP')]}
        owner={OWNER}
        run={run}
        closeSlippageBps={1000}
        closeWorst={closeWorstPrice}
        cancelsPerAction={20}
        heldKey={() => undefined}
        venueName="TEST venue"
        onSettled={onSettled}
      />,
    ),
  );
}

describe('Flatten everything (J-derivatives-33)', () => {
  it('#1 sends nothing when let go before 0.65 s, and fills only while held', async () => {
    const run = vi.fn<RunAction>();
    render(run, [position('BTC-PERP', 'long', '0.5')]);
    press('pointerdown');
    expect(button().getAttribute('data-holding')).not.toBeNull();
    await act(async () => void vi.advanceTimersByTime(600));
    press('pointerup');
    expect(button().getAttribute('data-holding')).toBeNull();
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(run).not.toHaveBeenCalled();
  });

  it('#2 #3 cancels every order, then closes every position reduce-only within 10% of the mark; all clear only from the venue read', async () => {
    const onSettled = vi.fn();
    // The venue applies each leg: once every one is answered, its read of the account is empty.
    const run = vi.fn<RunAction>(async (intent) => {
      if (intent.kind === 'cancel_orders') {
        venueReads.orders = [];
        return cancelled;
      }
      venueReads.positions = (venueReads.positions as VenuePosition[]).filter((p) => p.symbol !== symbolOf(intent));
      return filled;
    });
    render(run, [position('BTC-PERP', 'long', '0.5'), position('ETH-PERP', 'short', '2')], [order('BTC-PERP', '0xa1')], onSettled);
    await hold();
    expect(run).toHaveBeenCalledTimes(3);
    const [cancel, btc, eth] = run.mock.calls.map((c) => c[0] as Record<string, unknown>) as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(cancel).toMatchObject({ kind: 'cancel_orders', orders: [{ symbol: 'BTC-PERP', venueClientOrderId: '0xa1' }] });
    expect(btc).toMatchObject({
      kind: 'place_order',
      symbol: 'BTC-PERP',
      side: 'sell',
      type: 'market',
      amount: '0.5',
      price: '54000',
      reduceOnly: true,
      timeInForce: 'IOC',
    });
    // A short's buy is capped at the mark plus 10%.
    expect(eth).toMatchObject({ symbol: 'ETH-PERP', side: 'buy', amount: '2', price: '66000', reduceOnly: true });
    expect(btc.clientOrderKey).toMatch(/^close:/);
    expect(btc.clientOrderKey).not.toBe(eth.clientOrderKey);
    expect(lines().map((l) => l.getAttribute('data-state'))).toEqual(['done', 'done', 'done']);
    expect(verdict()?.getAttribute('data-verdict')).toBe('clear');
    expect(verdict()?.querySelector('time')?.getAttribute('dateTime')).toBe(venueReads.asOf);
    expect(onSettled).toHaveBeenCalled();
  });

  it('#3 every leg answered but the venue still lists a position: not all clear, never all clear', async () => {
    const run = vi.fn<RunAction>().mockResolvedValue(filled);
    render(run, [position('BTC-PERP', 'long', '0.5')]);
    await hold();
    expect(lines()[0]?.getAttribute('data-state')).toBe('done');
    expect(verdict()?.getAttribute('data-verdict')).toBe('not_clear');
    expect(verdict()?.textContent).toContain('BTC-PERP');
  });

  it('#4 #5 a refused close names the market and the venue reason; Retry sends only it, under the same client order key', async () => {
    const run = vi.fn<RunAction>(async (intent, opts) => {
      if (symbolOf(intent) === 'ETH-PERP' && !opts?.retryRefused) return refused('TEST close refused (TEST switch)');
      venueReads.positions = (venueReads.positions as VenuePosition[]).filter((p) => p.symbol !== symbolOf(intent));
      return filled;
    });
    render(run, [position('BTC-PERP', 'long', '0.5'), position('ETH-PERP', 'short', '2'), position('SOL-PERP', 'long', '3')]);
    await hold();
    expect(lines().map((l) => [l.getAttribute('data-symbol'), l.getAttribute('data-state')])).toEqual([
      ['BTC-PERP', 'done'],
      ['ETH-PERP', 'failed'],
      ['SOL-PERP', 'done'],
    ]);
    expect(verdict()?.getAttribute('data-verdict')).toBe('not_clear');
    expect(verdict()?.textContent).toContain('ETH-PERP (TEST close refused (TEST switch))');
    const firstKey = keyOf(run.mock.calls[1]![0]);
    const retryButton = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry ETH-PERP')!;
    expect([...host.querySelectorAll('button')].filter((b) => b.textContent?.startsWith('Retry'))).toHaveLength(1);
    await act(async () => {
      retryButton.click();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[3]![0]).toMatchObject({ symbol: 'ETH-PERP', clientOrderKey: firstKey, reduceOnly: true });
    expect(run.mock.calls[3]![1]).toEqual({ retryRefused: true });
    expect(verdict()?.getAttribute('data-verdict')).toBe('clear');
  });

  it('#6 a hold while a flatten runs starts nothing: each leg is sent once', async () => {
    let answer: (r: ActionResult) => void = () => undefined;
    const run = vi.fn<RunAction>(() => new Promise<ActionResult>((r) => (answer = r)));
    render(run, [position('BTC-PERP', 'long', '0.5')]);
    press('pointerdown');
    await act(async () => void (await vi.advanceTimersByTimeAsync(650)));
    press('pointerup');
    await hold();
    expect(run).toHaveBeenCalledTimes(1);
    venueReads.positions = [];
    await act(async () => {
      answer(filled);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(verdict()?.getAttribute('data-verdict')).toBe('clear');
  });

  it('an answer not known is read back from the venue; the next hold reads the same close, never a new one', async () => {
    const run = vi.fn<RunAction>().mockResolvedValue({ kind: 'unknown', clientOrderId: '0xc', nonce: null });
    render(run, [position('BTC-PERP', 'long', '0.5')]);
    await hold();
    expect(lines()[0]?.getAttribute('data-state')).toBe('unknown');
    await hold();
    expect(run).toHaveBeenCalledTimes(2);
    expect(keyOf(run.mock.calls[0]![0])).toBe(keyOf(run.mock.calls[1]![0]));
  });

  it('is not shown with no position and no order', () => {
    render(vi.fn<RunAction>(), []);
    expect(host.querySelector('[data-testid="venue-flatten"]')).toBeNull();
  });
});
