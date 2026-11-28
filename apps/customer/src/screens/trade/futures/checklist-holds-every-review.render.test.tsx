// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderIntent, RoutePreview, VenueMarket, VenuePreview, VenueUp } from '../../../features/trade/venue-api';
import type { ActionResult, RunAction, VenueAccount } from '../../../features/trade/venue/VenueKit';
import type { Checklist } from './pre-trade-checklist';
import { RoutedReview } from './VenueRoutes';
import { VenueSplitReview } from './VenueSplitReview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The pre-trade checklist (J-derivatives-34 #5) holds an opening order on every review that sends one, not only the
// single-order review: the split review (above the venue's cap) and the routed review (several venues) too.
vi.mock('../../../features/protocol/wallet/use-polled', () => ({
  usePolled: () => ({ data: null, failure: null, reload: vi.fn() }),
}));
vi.mock('../../../features/trade/venue/VenueKit', async (original) => ({
  ...(await original<typeof import('../../../features/trade/venue/VenueKit')>()),
  useVenueApi: () => ({ builderFeeApproval: () => Promise.resolve({ ok: true, data: { asOf: '', value: null } }) }),
}));

// A fake holding only the fields these reviews read; each field it writes is checked against T.
const partial = <T,>(x: Partial<T>): T => x as T;

const OWNER = '0x1111111111111111111111111111111111111111';
const CHECKLIST: Checklist = { on: true, items: ['Stop is set', 'Size fits my plan', 'Not revenge trading'] };
const STATUS = {
  enabled: true,
  available: true,
  venue: { id: 'hyperliquid', displayName: 'TEST Venue', proofLevel: 'partner-sandbox' },
  chainId: 421614,
  builder: null,
  test: true,
  routes: false,
  tradesSignedBy: 'session_key',
} as VenueUp;
const MARKET = partial<VenueMarket>({ symbol: 'BTC-PERP', baseAsset: 'BTC', quoteAsset: 'USDC', priceBand: { known: false } });
const PREVIEW = partial<VenuePreview>({
  symbol: 'BTC-PERP',
  kind: 'perpetual',
  lock: { asset: 'USDC', amount: '10' },
  role: 'taker',
  venueFee: { known: true, value: { asset: 'USDC', amount: '0.1' } },
  builderFee: { known: true, value: { asset: 'USDC', amount: '0' } },
  perpetual: null,
});
const order = (key: string, reduceOnly: boolean): OrderIntent => ({
  kind: 'place_order',
  symbol: 'BTC-PERP',
  side: 'buy',
  type: 'limit',
  amount: '1',
  price: '60000',
  timeInForce: 'GTC',
  reduceOnly,
  clientOrderKey: key,
  builderFee: null,
});
const account = partial<VenueAccount>({ reload: vi.fn() });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const boxes = () => [...host.querySelectorAll<HTMLInputElement>('[data-testid="pre-trade-checklist"] input[type="checkbox"]')];
const tick = (i: number) => act(() => boxes()[i]!.click());
const waits = () => host.querySelector('[data-testid="checklist-wait"]')?.textContent ?? null;
const press = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
  await act(async () => void button.click());
};

function renderSplit(reduceOnly: boolean, onConfirm: () => void) {
  act(() =>
    root.render(
      <VenueSplitReview
        data={{
          actionKey: 'split:k',
          orders: [order('split:k:1', reduceOnly), order('split:k:2', reduceOnly)],
          previews: [
            { venueId: 'v1', asOf: '2026-11-28T00:00:00Z', value: PREVIEW },
            { venueId: 'v1', asOf: '2026-11-28T00:00:00Z', value: PREVIEW },
          ],
          priceCorrected: null,
          tier: null,
        }}
        side="buy"
        market={MARKET}
        status={STATUS}
        account={account}
        owner={OWNER}
        run={vi.fn<RunAction>()}
        result={null}
        checklist={CHECKLIST}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    ),
  );
}

function renderRouted(reduceOnly: boolean, run: RunAction) {
  const route: RoutePreview = {
    symbol: 'BTC-PERP',
    side: 'buy',
    amount: '1',
    quoteAsset: 'USDC',
    chosen: {
      venueId: 'v1',
      displayName: 'TEST Venue',
      test: true,
      shownBest: null,
      preview: { venueId: 'v1', asOf: '2026-11-28T00:00:00Z', value: PREVIEW },
      cost: {
        venueId: 'v1',
        fillsNow: '1',
        averagePrice: '60000',
        fillsWhole: true,
        notional: '60000',
        knownFees: '0.1',
        total: '60000.1',
        unknownFees: [],
      },
    },
    others: [],
    excluded: [],
    reason: 'only_venue',
    at: '2026-11-28T00:00:00Z',
  };
  act(() =>
    root.render(
      <RoutedReview
        title="Review open long"
        route={route}
        intent={order('route:k', reduceOnly)}
        status={STATUS}
        owner={OWNER}
        run={run}
        resend={vi.fn()}
        confirmLabel="Open long"
        checklist={CHECKLIST}
        onSent={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
}

const sent: ActionResult = { kind: 'rejected' } as ActionResult;

describe('the pre-trade checklist holds an opening order on the split and routed reviews (J-derivatives-34 #5)', () => {
  it('split review: shows the items unticked, Confirm waits naming the unticked one and sends nothing, then sends once all are ticked', async () => {
    const onConfirm = vi.fn();
    renderSplit(false, onConfirm);
    expect(boxes().map((b) => b.checked)).toEqual([false, false, false]);
    tick(0);
    tick(1);
    await press('Open long');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(waits()).toContain('Not revenge trading');
    tick(2);
    expect(waits()).toBeNull();
    await press('Open long');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('split review: a reduce-only split never meets the checklist', async () => {
    const onConfirm = vi.fn();
    renderSplit(true, onConfirm);
    expect(boxes()).toHaveLength(0);
    await press('Open long');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('routed review: shows the items unticked, Confirm waits naming the unticked one and sends nothing, then sends once all are ticked', async () => {
    const run = vi.fn<RunAction>(async () => sent);
    renderRouted(false, run);
    expect(boxes().map((b) => b.checked)).toEqual([false, false, false]);
    tick(1);
    tick(2);
    await press('Open long');
    expect(run).not.toHaveBeenCalled();
    expect(waits()).toContain('Stop is set');
    tick(0);
    await press('Open long');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({ clientOrderKey: 'route:k', reduceOnly: false });
  });

  it('routed review: a reduce-only order never meets the checklist', async () => {
    const run = vi.fn<RunAction>(async () => sent);
    renderRouted(true, run);
    expect(boxes()).toHaveLength(0);
    await press('Open long');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
