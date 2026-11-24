// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { draftSchema, previewSchema } from '../../../features/trade/trade-api';
import { BuyReview } from './BuyReview';
import { afterFee, afterQuoteFee, aboutValue, costRows, feeUsd, limitFor, protectedTotal, spreadOf } from './cost';
import { formatGet } from './cost-format';
import { fmtUsd } from './deps';

// Each of cost.ts's helpers, as the modules that import it see it, counted: what BuyReview asks for is on record.
vi.mock('./cost', async (original) => {
  const real = await original<typeof import('./cost')>();
  return Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === 'function' ? vi.fn(value) : value]));
});

describe('feeUsd (#10702: every fee in dollars as well as its own unit)', () => {
  it('a fee in a dollar coin is that many dollars', () => {
    expect(feeUsd('0.04915925', 'USDT', 'BTC', 'USDT', '64683.23')).toBe('0.04915925');
    expect(feeUsd('0.1', 'USDC', 'BTC', 'USDC', null)).toBe('0.1');
  });
  it("a fee in the coin is counted at the order's price, rounded up", () => {
    // 0.00000154 BTC at 64,871.11 = 0.0999015094
    expect(feeUsd('0.00000154', 'BTC', 'BTC', 'USDT', '64871.11')).toBe('0.0999015094');
  });
  it('is unknown without a price, for another asset, or with no fee', () => {
    expect(feeUsd('0.00000154', 'BTC', 'BTC', 'USDT', null)).toBeNull();
    expect(feeUsd('1', 'IFC', 'BTC', 'USDT', '65000')).toBeNull();
    expect(feeUsd('0.001', 'ETH', 'ETH', 'BTC', '0.05')).toBeNull();
    expect(feeUsd(null, 'USDT', 'BTC', 'USDT', '65000')).toBeNull();
    expect(feeUsd('0.1', null, 'BTC', 'USDT', '65000')).toBeNull();
  });
});

describe('spreadOf', () => {
  it('is the ask less the bid, and its share of the middle price', () => {
    // The walk: 64,683.23 and 64,871.11 are 187.88 apart, 0.2900...% of the middle 64,777.17
    const spread = spreadOf('64683.23', '64871.11');
    expect(spread).toMatchObject({ bid: '64683.23', ask: '64871.11', width: '187.88' });
    expect(spread!.ratio.startsWith('0.0029')).toBe(true);
    expect(spreadOf('100', '100')).toMatchObject({ width: '0', ratio: '0' });
  });
  it('is unknown with either side missing, or an ask below the bid', () => {
    expect(spreadOf(null, '1')).toBeNull();
    expect(spreadOf('1', null)).toBeNull();
    expect(spreadOf('2', '1')).toBeNull();
    expect(spreadOf('0', '1')).toBeNull();
  });
});

describe('protectedTotal', () => {
  it('rounds the most a buyer can pay UP to the cent', () => {
    // 0.00123 * 65000.123 = 79.95015129 -> 79.96
    expect(protectedTotal('buy', '0.00123', '65000.123')).toBe('79.96');
  });
  it('rounds the least a seller gets DOWN to the cent', () => {
    expect(protectedTotal('sell', '0.00123', '65000.123')).toBe('79.95');
  });
  it('leaves an exact cent alone on both sides', () => {
    expect(protectedTotal('buy', '2', '1.25')).toBe('2.5');
    expect(protectedTotal('sell', '2', '1.25')).toBe('2.5');
  });
  it('is null without a protection price or amount', () => {
    expect(protectedTotal('buy', '1', null)).toBeNull();
    expect(protectedTotal('sell', 'x', '10')).toBeNull();
    expect(protectedTotal('buy', '1', '0')).toBeNull();
  });
});

describe('aboutValue / afterFee', () => {
  it('rounds the estimate down', () => {
    expect(aboutValue('0.5', '3.333')).toBe('1.6665');
    expect(aboutValue('x', '1')).toBeNull();
  });
  it('takes a fee in the bought coin off the amount', () => {
    expect(afterFee('0.0001', '0.00000008', 'BTC', 'BTC')).toBe('0.00009992');
  });
  it('knows nothing when the fee is in another asset, unknown or larger than the amount', () => {
    expect(afterFee('1', '0.1', 'USDT', 'BTC')).toBeNull();
    expect(afterFee('1', null, null, 'BTC')).toBeNull();
    expect(afterFee('1', '2', 'BTC', 'BTC')).toBeNull();
  });
  it('takes a fee in the paying money off a sell', () => {
    expect(afterQuoteFee('100', '0.1', 'USDT', 'USDT')).toBe('99.9');
    expect(afterQuoteFee('100', '0.1', 'BTC', 'USDT')).toBeNull();
  });
});

describe('costRows', () => {
  const base = { base: '0.001', price: '65000', baseAsset: 'BTC', quoteAsset: 'USDT' };
  it('buy with the fee in USDT: full coin amount, most you can pay rounded up', () => {
    const rows = costRows({
      ...base,
      side: 'buy',
      preview: { estimatedFee: '0.065', feeAsset: 'USDT', protectionPrice: '65325.001' },
    });
    expect(rows.estimated).toBe('65');
    expect(rows.fee).toEqual({ amount: '0.065', asset: 'USDT', usd: '0.065' });
    expect(rows.get).toEqual({ kind: 'coin', amount: '0.001', afterFee: false });
    // 0.001 * 65325.001 = 65.325001, plus the 0.065 USDT fee = 65.390001 -> 65.40
    expect(rows.limit).toBe('65.4');
  });
  it('buy with the fee in the coin: shows the amount after the fee', () => {
    const rows = costRows({ ...base, side: 'buy', preview: { estimatedFee: '0.000001', feeAsset: 'BTC', protectionPrice: '65000' } });
    expect(rows.get).toEqual({ kind: 'coin', amount: '0.000999', afterFee: true });
  });
  it('sell: least you get rounds down and the get line is money after a USDT fee', () => {
    const rows = costRows({ ...base, side: 'sell', preview: { estimatedFee: '0.065', feeAsset: 'USDT', protectionPrice: '64674.999' } });
    // 64.674999 - 0.065 = 64.609999 -> 64.6
    expect(rows.limit).toBe('64.6');
    expect(rows.get).toEqual({ kind: 'money', amount: '64.935' });
  });
  it('a fee in the coin leaves the money limit as before', () => {
    const buy = costRows({ ...base, side: 'buy', preview: { estimatedFee: '0.000001', feeAsset: 'BTC', protectionPrice: '65325.001' } });
    expect(buy.limit).toBe('65.33');
    const sell = costRows({ ...base, side: 'sell', preview: { estimatedFee: '0.000001', feeAsset: 'BTC', protectionPrice: '64674.999' } });
    expect(sell.limit).toBe('64.67');
  });
  it('sell never goes below zero when the fee is larger than the proceeds', () => {
    const rows = costRows({ ...base, side: 'sell', preview: { estimatedFee: '100', feeAsset: 'USDT', protectionPrice: '1000' } });
    expect(rows.limit).toBe('0');
  });
  it('an unknown fee leaves the limit unknown', () => {
    expect(costRows({ ...base, side: 'buy', preview: { estimatedFee: null, feeAsset: null, protectionPrice: '65000' } }).limit).toBeNull();
    expect(
      costRows({ ...base, side: 'sell', preview: { estimatedFee: '0.1', feeAsset: null, protectionPrice: '65000' } }).limit,
    ).toBeNull();
  });
  it('shows nothing for parts it cannot know', () => {
    const rows = costRows({ ...base, side: 'buy', price: null, preview: null });
    expect(rows).toEqual({ estimated: null, fee: null, get: null, limit: null });
    const noProtection = costRows({ ...base, side: 'buy', preview: { estimatedFee: null, feeAsset: null, protectionPrice: null } });
    expect(noProtection.limit).toBeNull();
    expect(noProtection.get).toBeNull();
    expect(noProtection.fee).toBeNull();
  });
});

describe('limitFor (the card and the review dialog share one worst case)', () => {
  it('counts a fee in the paying money, rounding the buy up and the sell down', () => {
    const fee = { estimatedFee: '0.065', feeAsset: 'USDT' };
    // 0.001 * 64674.999 = 64.674999, less the 0.065 USDT fee = 64.609999 -> 64.6 (the bare protectedTotal says 64.67)
    expect(limitFor('sell', '0.001', { ...fee, protectionPrice: '64674.999' }, 'USDT')).toBe('64.6');
    expect(limitFor('buy', '0.001', { ...fee, protectionPrice: '65325.001' }, 'USDT')).toBe('65.4');
  });
  it('stays unknown when the fee is unknown', () => {
    expect(limitFor('buy', '0.001', { estimatedFee: null, feeAsset: null, protectionPrice: '65000' }, 'USDT')).toBeNull();
  });
  it('is what costRows reports as the limit', () => {
    const preview = { estimatedFee: '0.065', feeAsset: 'USDT', protectionPrice: '64674.999' };
    const rows = costRows({ side: 'sell', base: '0.001', price: '65000', baseAsset: 'BTC', quoteAsset: 'USDT', preview });
    expect(rows.limit).toBe(limitFor('sell', '0.001', preview, 'USDT'));
  });
  // Every shape BuyReview draws differently: buy or sell, market (a protection price) or limit (none), a sizing price or
  // none, a known fee or none, and the changed, error and busy notes. Each takes its figures from costRows alone.
  const market = {
    symbol: 'BTC/USDT',
    base: 'BTC',
    quote: 'USDT',
    orderable: true,
    tickSize: '0.01',
    lotSize: '0.00001',
    minAmount: null,
    listedAt: null,
  };
  type Shape = {
    name: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    price: string | null;
    protectionPrice: string | null;
    fee: { estimatedFee: string | null; feeAsset: string | null };
    changed?: boolean;
    message?: string | null;
    busy?: boolean;
  };
  const shapes: Shape[] = [
    {
      name: 'a market buy',
      side: 'buy',
      type: 'market',
      price: '65000',
      protectionPrice: '65325.001',
      fee: { estimatedFee: '0.065', feeAsset: 'USDT' },
    },
    {
      name: 'a market buy, fee in the coin, price moved',
      side: 'buy',
      type: 'market',
      price: '65000',
      protectionPrice: '65325.001',
      fee: { estimatedFee: '0.000001', feeAsset: 'BTC' },
      changed: true,
    },
    {
      name: 'a market buy with no sizing price',
      side: 'buy',
      type: 'market',
      price: null,
      protectionPrice: '65325.001',
      fee: { estimatedFee: '0.065', feeAsset: 'USDT' },
    },
    {
      name: 'a market buy with the fee unknown',
      side: 'buy',
      type: 'market',
      price: '65000',
      protectionPrice: '65325.001',
      fee: { estimatedFee: null, feeAsset: null },
      message: 'TEST refusal',
    },
    {
      name: 'a limit buy',
      side: 'buy',
      type: 'limit',
      price: '64000',
      protectionPrice: null,
      fee: { estimatedFee: '0.000001', feeAsset: 'BTC' },
      busy: true,
    },
    {
      name: 'a market sell',
      side: 'sell',
      type: 'market',
      price: '65000',
      protectionPrice: '64674.999',
      fee: { estimatedFee: '0.065', feeAsset: 'USDT' },
    },
    {
      name: 'a market sell with no sizing price',
      side: 'sell',
      type: 'market',
      price: null,
      protectionPrice: '64674.999',
      fee: { estimatedFee: '0.065', feeAsset: 'USDT' },
      changed: true,
    },
    {
      name: 'a market sell with the fee unknown',
      side: 'sell',
      type: 'market',
      price: '65000',
      protectionPrice: '64674.999',
      fee: { estimatedFee: null, feeAsset: null },
      busy: true,
    },
    {
      name: 'a limit sell',
      side: 'sell',
      type: 'limit',
      price: '66000',
      protectionPrice: null,
      fee: { estimatedFee: '0.065', feeAsset: 'USDT' },
      message: 'TEST refusal',
    },
  ];
  const bare = { aboutValue, afterFee, afterQuoteFee, limitFor, protectedTotal };
  const shown = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

  /** Draws the dialog and reads what it shows; the spies count only the dialog's own calls. */
  async function draw(review: Parameters<typeof BuyReview>[0]['review'], notes: Pick<Shape, 'message' | 'busy'> = {}) {
    for (const helper of [costRows, ...Object.values(bare)]) vi.mocked(helper).mockClear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(BuyReview, {
            review,
            market,
            busy: notes.busy ?? false,
            message: notes.message ?? null,
            onCancel: () => undefined,
            onConfirm: () => undefined,
          }),
        ),
      );
      const seen = {
        pay: shown('review-pay'),
        get: shown('review-get'),
        limit: shown('review-limit'),
        bid: shown('review-bid'),
        ask: shown('review-ask'),
        spread: shown('review-spread'),
        fee: shown('review-fee'),
        feeUsd: shown('review-fee-usd'),
      };
      const called = Object.entries(bare).flatMap(([name, helper]) => (vi.mocked(helper).mock.calls.length ? [name] : []));
      return { seen, costRowsCalls: vi.mocked(costRows).mock.calls.length, called };
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  }

  it.each(shapes.map((shape) => [shape.name, shape] as const))(
    'BuyReview.tsx takes its figures from costRows and never from the bare helpers: %s',
    async (_name, shape) => {
      const preview = previewSchema.parse({
        symbol: 'BTC/USDT',
        side: shape.side,
        type: shape.type,
        amount: '0.001',
        price: shape.type === 'limit' ? shape.price : null,
        timeInForce: shape.type === 'limit' ? 'GTC' : 'IOC',
        holdAsset: shape.side === 'buy' ? 'USDT' : 'BTC',
        holdAmount: shape.side === 'buy' ? '65.4' : '0.001',
        protectionPrice: shape.protectionPrice,
        ...shape.fee,
        feeBps: 10,
        feeRole: 'taker',
        orderable: true,
        refusals: [],
      });
      const draft = draftSchema.parse({
        symbol: 'BTC/USDT',
        side: shape.side,
        type: shape.type,
        amount: '0.001',
        ...(shape.type === 'limit' ? { price: shape.price } : {}),
        timeInForce: shape.type === 'limit' ? 'GTC' : 'IOC',
        postOnly: false,
        clientOrderId: 'TEST-1',
      });
      const { seen, costRowsCalls, called } = await draw(
        { draft, preview, price: shape.price, bid: null, ask: null, changed: shape.changed ?? false },
        shape,
      );
      expect(costRowsCalls, 'the dialog reads costRows').toBeGreaterThan(0);
      expect(called, 'bare helpers the dialog called').toEqual([]);
      const rows = costRows({ side: shape.side, base: '0.001', price: shape.price, baseAsset: 'BTC', quoteAsset: 'USDT', preview });
      expect(seen.limit).toBe(rows.limit == null ? '—' : fmtUsd(rows.limit));
      expect(seen.get).toBe(formatGet(rows.get, 'BTC', 5, (_key, p) => `${p.amount} ${p.coin} after the fee`) ?? '—');
      if (shape.side === 'buy') expect(seen.pay).toBe(rows.estimated == null ? '—' : fmtUsd(rows.estimated));
    },
  );

  it('shows the limit after the fee on both sides, never the bare protected total', async () => {
    for (const [side, protection, after, bareTotal] of [
      ['sell', '64674.999', '$64.60', '$64.67'],
      ['buy', '65325.001', '$65.40', '$65.33'],
    ] as const) {
      const fee = { estimatedFee: '0.065', feeAsset: 'USDT' };
      const preview = previewSchema.parse({
        symbol: 'BTC/USDT',
        side,
        type: 'market',
        amount: '0.001',
        price: null,
        timeInForce: 'IOC',
        holdAsset: side === 'buy' ? 'USDT' : 'BTC',
        holdAmount: '0.001',
        protectionPrice: protection,
        ...fee,
        feeBps: 10,
        feeRole: 'taker',
        orderable: true,
        refusals: [],
      });
      const draft = draftSchema.parse({
        symbol: 'BTC/USDT',
        side,
        type: 'market',
        amount: '0.001',
        timeInForce: 'IOC',
        postOnly: false,
        clientOrderId: 'TEST-1',
      });
      const { seen } = await draw({ draft, preview, price: '65000', bid: null, ask: null, changed: false });
      expect(seen.limit, side).toBe(after);
      expect(fmtUsd(protectedTotal(side, '0.001', protection)!), side).toBe(bareTotal);
    }
  });

  it('shows the best bid, the best ask, the spread, and the fee in dollars beside its own unit (#10702)', async () => {
    const preview = previewSchema.parse({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      amount: '0.00153846',
      price: null,
      timeInForce: 'IOC',
      holdAsset: 'USDT',
      holdAmount: '100.41',
      protectionPrice: '65195.47',
      estimatedFee: '0.00000154',
      feeAsset: 'BTC',
      feeBps: 10,
      feeRole: 'taker',
      orderable: true,
      refusals: [],
    });
    const draft = draftSchema.parse({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      amount: '0.00153846',
      timeInForce: 'IOC',
      postOnly: false,
      clientOrderId: 'TEST-1',
    });
    const { seen } = await draw({ draft, preview, price: '64871.11', bid: '64683.23', ask: '64871.11', changed: false });
    expect(seen).toMatchObject({
      bid: '$64,683.23',
      ask: '$64,871.11',
      spread: '$187.88 (0.290%)',
      fee: '0.00000154 BTC',
      feeUsd: ' (about $0.0999)',
    });
    // Unknown sides read as a dash, never a guessed spread.
    const blank = await draw({ draft, preview, price: '64871.11', bid: null, ask: '64871.11', changed: false });
    expect(blank.seen).toMatchObject({ bid: '—', ask: '$64,871.11', spread: '—' });
  });

  it('with no review open, asks for no figures at all', async () => {
    const { seen, costRowsCalls, called } = await draw(null);
    expect(seen).toEqual({ pay: null, get: null, limit: null, bid: null, ask: null, spread: null, fee: null, feeUsd: null });
    expect(costRowsCalls).toBe(0);
    expect(called).toEqual([]);
  });
});

describe('sell review figures (the card and the dialog read the same costRows)', () => {
  const preview = { estimatedFee: '1.300975', feeAsset: 'USDT', protectionPrice: '2588.94' };
  const rows = costRows({ side: 'sell', base: '0.5', price: '2601.95', baseAsset: 'ETH', quoteAsset: 'USDT', preview });
  it('gets the money after the USDT fee, not the gross value', () => {
    expect(rows.estimated).toBe('1300.975');
    expect(rows.get).toEqual({ kind: 'money', amount: '1299.674025' });
  });
  it('has the least the seller gets, after the fee, rounded down to the cent', () => {
    // 0.5 * 2588.94 = 1294.47, less 1.300975 = 1293.169025 -> 1293.16
    expect(rows.limit).toBe('1293.16');
  });
});

describe('formatGet', () => {
  const t = (_key: '{amount} {coin} after the fee', p: { amount: string; coin: string }) => `${p.amount} ${p.coin} after the fee`;
  it('writes money as dollars', () => {
    expect(formatGet({ kind: 'money', amount: '1299.674025' }, 'ETH', 4, t)).toBe('$1,299.67');
  });
  it('writes coins after a fee in those coins with the words', () => {
    expect(formatGet({ kind: 'coin', amount: '0.00007992', afterFee: true }, 'BTC', 5, t)).toBe('0.00007992 BTC after the fee');
  });
  it('writes coins with the fee paid elsewhere in full, to the lot places', () => {
    expect(formatGet({ kind: 'coin', amount: '0.0001', afterFee: false }, 'BTC', 5, t)).toBe('0.0001 BTC');
  });
  it('is null when it is not known (the caller shows a dash)', () => {
    expect(formatGet(null, 'BTC', 5, t)).toBeNull();
  });
});
