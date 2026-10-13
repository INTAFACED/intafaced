import { describe, expect, it } from 'vitest';
import {
  classOf,
  computeMovers,
  DAY_MS,
  derive24h,
  forwardFill,
  HOUR_MS,
  mergeTicker,
  primarySymbolFor,
  priceSymbolsFor,
  sparklineFor,
  valuePortfolio,
  type OhlcvRow,
  type RawTicker,
} from './derive';
import { fmtPct, fmtUsd } from './format';
import type { MarketRow, TickerRow } from './types';

// A fixed "now" in the middle of an hour: 2026-10-13 12:30:00 UTC.
const NOW = Date.UTC(2026, 9, 13, 12, 30, 0);
const hour = (hoursAgo: number) => Math.floor(NOW / HOUR_MS) * HOUR_MS - hoursAgo * HOUR_MS;
const row = (t: number, o: string, h: string, l: string, c: string, v: string): OhlcvRow => [t, o, h, l, c, v];

function market(base: string, quote: string, orderable = true): MarketRow {
  return { symbol: `${base}/${quote}`, base, quote, orderable, tickSize: '0.01', lotSize: '0.0001', minAmount: '0.0001', listedAt: null };
}

function ticker(symbol: string, last: string | null, open24h: string | null, extra: Partial<TickerRow> = {}): TickerRow {
  return {
    symbol,
    last,
    bid: null,
    ask: null,
    open24h,
    high24h: null,
    low24h: null,
    change24h: null,
    changePct24h: null,
    baseVolume24h: null,
    quoteVolume24h: null,
    windowStart: NOW - DAY_MS,
    source: 'derived',
    ...extra,
  };
}

const raw = (symbol: string, last: string | null, extra: Partial<RawTicker> = {}): RawTicker => ({
  symbol,
  timestamp: NOW,
  last,
  bid: null,
  ask: null,
  open: null,
  high: null,
  low: null,
  change: null,
  percentage: null,
  baseVolume: null,
  quoteVolume: null,
  ...extra,
});

describe('forwardFill', () => {
  it('turns a silent hour into a flat candle at the previous close, volume 0, marked filled', () => {
    const out = forwardFill([row(hour(3), '100', '110', '95', '105', '2'), row(hour(1), '106', '108', '104', '107', '1')], {
      stepMs: HOUR_MS,
      nowMs: NOW,
    });
    expect(out.map((c) => c.t)).toEqual([hour(3), hour(2), hour(1), hour(0)]);
    expect(out[1]).toEqual({ t: hour(2), o: '105', h: '105', l: '105', c: '105', v: '0', filled: true });
    expect(out[0]!.filled).toBe(false);
    // The current, still-silent hour is also filled so the chart reaches "now".
    expect(out[3]).toEqual({ t: hour(0), o: '107', h: '107', l: '107', c: '107', v: '0', filled: true });
  });

  it('keeps decimal strings untouched (no number round-trip)', () => {
    const out = forwardFill([row(hour(1), '0.1', '0.30000000000000004', '0.1', '0.123456789012345678', '1')], {
      stepMs: HOUR_MS,
      nowMs: NOW,
    });
    expect(out[0]!.h).toBe('0.30000000000000004');
    expect(out[1]!.c).toBe('0.123456789012345678');
  });

  it('returns nothing for no candles', () => {
    expect(forwardFill([], { stepMs: HOUR_MS, nowMs: NOW })).toEqual([]);
  });

  it('starts at fromMs but still carries the close from earlier candles', () => {
    const out = forwardFill([row(hour(30), '1', '1', '1', '9', '1')], { stepMs: HOUR_MS, nowMs: NOW, fromMs: hour(2) });
    expect(out.map((c) => c.t)).toEqual([hour(2), hour(1), hour(0)]);
    expect(out.every((c) => c.c === '9' && c.filled)).toBe(true);
  });

  it('merges duplicates and snaps unaligned times to their bucket', () => {
    const out = forwardFill([row(hour(1) + 123, '1', '2', '1', '2', '1'), row(hour(1) + 456, '5', '6', '5', '6', '1')], {
      stepMs: HOUR_MS,
      nowMs: NOW,
    });
    expect(out[0]).toMatchObject({ t: hour(1), o: '5' });
  });

  it('bounds the work for a long silence', () => {
    const out = forwardFill([row(hour(100000), '1', '1', '1', '1', '1')], { stepMs: 60_000, nowMs: NOW, maxBuckets: 50 });
    expect(out.length).toBe(50);
  });

  it('works for other timeframes', () => {
    const out = forwardFill([row(Math.floor(NOW / 60_000) * 60_000 - 180_000, '1', '1', '1', '1', '1')], { stepMs: 60_000, nowMs: NOW });
    expect(out.length).toBe(4);
  });
});

describe('derive24h', () => {
  it('uses the first candle at or after now-24h for the open, and sums the window exactly', () => {
    // 25 hourly candles from hour(24) to hour(0); the one at hour(24) is before the cut (now-24h = 12:30 yesterday).
    const rows: OhlcvRow[] = [];
    for (let h = 24; h >= 0; h -= 1) rows.push(row(hour(h), String(100 + h), String(200 + h), String(50 + h), String(100 + h), '0.1'));
    const stats = derive24h(rows, NOW)!;
    expect(stats.open24h).toBe('123'); // hour(23): the first candle at or after the cut
    expect(stats.high24h).toBe('223');
    expect(stats.low24h).toBe('50'); // hour(0)
    expect(stats.baseVolume24h).toBe('2.4'); // 24 candles x 0.1, exact (a float sum would give 2.4000000000000004)
    expect(stats.windowStart).toBe(NOW - DAY_MS); // full window
    expect(stats.sparkline.length).toBe(24);
    expect(stats.sparkline[23]).toBe('100');
  });

  it('reports a young market as a partial window starting at its first candle', () => {
    const stats = derive24h([row(hour(3), '10', '12', '9', '11', '1'), row(hour(1), '11', '13', '11', '12', '2')], NOW)!;
    expect(stats.open24h).toBe('10');
    expect(stats.windowStart).toBe(hour(3));
    expect(stats.windowStart).toBeGreaterThan(NOW - DAY_MS);
    expect(stats.high24h).toBe('13');
    expect(stats.low24h).toBe('9');
    expect(stats.baseVolume24h).toBe('3');
  });

  it('a market with no trades for days is flat, not unknown', () => {
    const stats = derive24h([row(hour(100), '7', '8', '6', '7.5', '1')], NOW)!;
    expect(stats.open24h).toBe('7.5');
    expect(stats.high24h).toBe('7.5');
    expect(stats.low24h).toBe('7.5');
    expect(stats.baseVolume24h).toBe('0');
    expect(stats.windowStart).toBe(NOW - DAY_MS);
  });

  it('no candles means no stats at all', () => {
    expect(derive24h([], NOW)).toBeNull();
  });
});

describe('mergeTicker', () => {
  const stats = derive24h([row(hour(3), '100', '120', '90', '105', '1.5'), row(hour(0), '105', '112', '104', '110', '0.5')], NOW)!;

  it('derives change and percent from last versus the 24 h open and marks the row derived', () => {
    const merged = mergeTicker(raw('BTC/USDT', '110'), stats);
    expect(merged).toMatchObject({
      symbol: 'BTC/USDT',
      last: '110',
      open24h: '100',
      high24h: '120',
      low24h: '90',
      baseVolume24h: '2',
      quoteVolume24h: null,
      change24h: '10',
      changePct24h: '0.1',
      source: 'derived',
      windowStart: hour(3),
    });
    expect(fmtPct(merged.changePct24h)).toBe('+10.00%');
  });

  it('negative moves keep their sign', () => {
    const merged = mergeTicker(raw('BTC/USDT', '99.72'), stats);
    expect(merged.change24h).toBe('-0.28');
    expect(merged.changePct24h).toBe('-0.0028');
    expect(fmtPct(merged.changePct24h)).toBe('−0.28%');
  });

  it('prefers every field the server already sends (U1)', () => {
    const merged = mergeTicker(
      raw('BTC/USDT', '110', {
        open: '98',
        high: '130',
        low: '80',
        baseVolume: '9',
        quoteVolume: '900',
        change: '12',
        percentage: '12.2449',
      }),
      stats,
    );
    expect(merged).toMatchObject({
      open24h: '98',
      high24h: '130',
      low24h: '80',
      baseVolume24h: '9',
      quoteVolume24h: '900',
      change24h: '12',
      source: 'server',
    });
    expect(merged.windowStart).toBe(NOW - DAY_MS);
  });

  it('fills only the gaps when the server sends some fields', () => {
    const merged = mergeTicker(raw('BTC/USDT', '110', { open: '98' }), stats);
    expect(merged.open24h).toBe('98');
    expect(merged.high24h).toBe('120');
    expect(merged.source).toBe('derived');
  });

  it('converts a CCXT percent to a ratio only when open and change are missing', () => {
    const merged = mergeTicker(raw('X/USDT', '10', { percentage: '2.5' }), null);
    expect(merged.changePct24h).toBe('0.025');
    expect(merged.change24h).toBeNull();
  });

  it('is unknown, never zero, when last or the open is missing', () => {
    const noLast = mergeTicker(raw('BTC/USDT', null), stats);
    expect(noLast.change24h).toBeNull();
    expect(noLast.changePct24h).toBeNull();
    const noOpen = mergeTicker(raw('BTC/USDT', '110'), null);
    expect(noOpen).toMatchObject({
      open24h: null,
      change24h: null,
      changePct24h: null,
      high24h: null,
      baseVolume24h: null,
      windowStart: null,
    });
  });

  it('a zero open cannot produce a percent', () => {
    const merged = mergeTicker(raw('X/USDT', '1', { open: '0' }), null);
    expect(merged.changePct24h).toBeNull();
  });

  it('carries the book prices only when they are real', () => {
    const merged = mergeTicker(raw('ETH/USDC', '2598.51', { bid: null, ask: null }), null);
    expect(merged.bid).toBeNull();
    expect(merged.ask).toBeNull();
  });
});

describe('sparklineFor', () => {
  const stats = derive24h([row(hour(2), '1', '1', '1', '1', '1'), row(hour(1), '2', '2', '2', '2', '1')], NOW)!;
  it('prefers the server array', () => {
    expect(sparklineFor(raw('X', '1', { sparkline: ['1', '2', '3'] }), stats)).toEqual(['1', '2', '3']);
  });
  it('falls back to derived closes', () => {
    expect(sparklineFor(raw('X', '1'), stats)).toEqual(['1', '2', '2']);
  });
  it('needs at least two points to draw', () => {
    expect(sparklineFor(raw('X', '1', { sparkline: ['1'] }), null)).toBeNull();
    expect(sparklineFor(undefined, null)).toBeNull();
  });
});

describe('primarySymbolFor', () => {
  const markets = [market('BTC', 'USDC'), market('BTC', 'USDT'), market('ETH', 'USDC'), market('IFC', 'USDT'), market('WTI', 'USD')];
  it('prefers the USDT market, then USDC, else null', () => {
    expect(primarySymbolFor('BTC', markets)).toBe('BTC/USDT');
    expect(primarySymbolFor('ETH', markets)).toBe('ETH/USDC');
    expect(primarySymbolFor('WTI', markets)).toBeNull();
    expect(primarySymbolFor('DOGE', markets)).toBeNull();
    expect(primarySymbolFor('btc', markets)).toBe('BTC/USDT');
  });
  it('lists the fallbacks in order', () => {
    expect(priceSymbolsFor('BTC', markets)).toEqual(['BTC/USDT', 'BTC/USDC']);
  });
});

describe('classOf', () => {
  it('stablecoins and fiat codes are cash, the rest crypto', () => {
    expect(classOf('USDT')).toBe('cash');
    expect(classOf('USDC')).toBe('cash');
    expect(classOf('USD')).toBe('cash');
    expect(classOf('EUR')).toBe('cash');
    expect(classOf('BTC')).toBe('crypto');
    expect(classOf('IFC')).toBe('crypto');
  });
});

describe('computeMovers', () => {
  const markets = [
    market('BTC', 'USDT'),
    market('BTC', 'USDC'),
    market('ETH', 'USDT'),
    market('IFC', 'USDT'),
    market('SOL', 'USDT'),
    market('DEAD', 'USDT'),
  ];
  const t = (symbol: string, pct: string | null) => ticker(symbol, '1', '1', { changePct24h: pct });
  const tickers = {
    'BTC/USDT': t('BTC/USDT', '0.0124'),
    'BTC/USDC': t('BTC/USDC', '0.5'),
    'ETH/USDT': t('ETH/USDT', '-0.03'),
    'IFC/USDT': t('IFC/USDT', '0.002'),
    'SOL/USDT': t('SOL/USDT', '0'),
    'DEAD/USDT': t('DEAD/USDT', null),
  };
  it('ranks gainers and losers, one row per coin, USDT market wins, zero and unknown excluded', () => {
    const { gainers, losers } = computeMovers(tickers, markets, 6);
    expect(gainers.map((r) => r.symbol)).toEqual(['BTC/USDT', 'IFC/USDT']);
    expect(losers.map((r) => r.symbol)).toEqual(['ETH/USDT']);
  });
  it('honours the limit', () => {
    expect(computeMovers(tickers, markets, 1).gainers.length).toBe(1);
    expect(computeMovers(tickers, markets, 0).gainers.length).toBe(0);
  });
  it('ignores tickers with no matching market', () => {
    expect(computeMovers({ 'ZZZ/USDT': t('ZZZ/USDT', '0.9') }, markets, 6).gainers).toEqual([]);
  });
});

describe('valuePortfolio: total value (UI-SPEC §1.2)', () => {
  const markets = [market('BTC', 'USDT'), market('BTC', 'USDC'), market('ETH', 'USDT'), market('IFC', 'USDT'), market('SOL', 'USDC')];
  const balances = {
    BTC: { free: '3.7', used: '0.048', total: '3.748' },
    ETH: { free: '12.5', used: '0', total: '12.5' },
    IFC: { free: '100', used: '0', total: '100' },
    USDC: { free: '9.26', used: '0', total: '9.26' },
    USDT: { free: '15.11', used: '0', total: '15.11' },
  };
  const tickers = {
    'BTC/USDT': ticker('BTC/USDT', '65242.3', '64000'),
    'BTC/USDC': ticker('BTC/USDC', '99999', '1'), // must not be used: USDT wins
    'ETH/USDT': ticker('ETH/USDT', '2650.55', '2700.55'),
    'IFC/USDT': ticker('IFC/USDT', '1.0036', '1'),
  };

  it('equals the hand-computed sum, to the cent', () => {
    // BTC 3.748 x 65242.3   = 244528.1404
    // ETH 12.5  x 2650.55   =  33131.875
    // IFC 100   x 1.0036    =    100.36
    // USDC 9.26 + USDT 15.11 =   24.37          (each counts as exactly 1 USD)
    // total                  = 277784.7454  ->  $277,784.75
    const summary = valuePortfolio({ balances, markets, tickers, nowMs: NOW });
    expect(summary.totalUsd).toBe('277784.7454');
    expect(fmtUsd(summary.totalUsd)).toBe('$277,784.75');
    expect(summary.cashUsd).toBe('24.37');
    expect(summary.cryptoUsd).toBe('277760.3754');
    expect(summary.unpriced).toEqual([]);
    expect(summary.source).toBe('derived');
  });

  it("today's change is amount x (last - open24h), summed", () => {
    // BTC 3.748 x (65242.3 - 64000)   =  4656.1404
    // ETH 12.5  x (2650.55 - 2700.55) =  -625
    // IFC 100   x (1.0036 - 1)        =     0.36
    // total change                    =  4031.5004
    // value a day ago = 277784.7454 - 4031.5004 = 273753.245 -> 4031.5004 / 273753.245 = +1.47%
    const summary = valuePortfolio({ balances, markets, tickers, nowMs: NOW });
    expect(summary.change24hUsd).toBe('4031.5004');
    expect(fmtUsd(summary.change24hUsd, { showPlus: true })).toBe('+$4,031.50');
    expect(fmtPct(summary.change24hPct)).toBe('+1.47%');
  });

  it('per-coin rows carry value, change, share and the pricing market, largest first', () => {
    const summary = valuePortfolio({ balances, markets, tickers, nowMs: NOW });
    expect(summary.holdings.map((h) => h.asset)).toEqual(['BTC', 'ETH', 'IFC', 'USDT', 'USDC']);
    const btc = summary.holdings[0]!;
    expect(btc).toMatchObject({
      asset: 'BTC',
      class: 'crypto',
      total: '3.748',
      available: '3.7',
      inOrders: '0.048',
      usdValue: '244528.1404',
      usdChange24h: '4656.1404',
      priceSymbol: 'BTC/USDT',
    });
    const usdt = summary.holdings.find((h) => h.asset === 'USDT')!;
    expect(usdt).toMatchObject({ class: 'cash', usdValue: '15.11', usdChange24h: '0', priceSymbol: null });
    const shares = summary.holdings.map((h) => h.share!);
    expect(shares.every((s) => s !== null)).toBe(true);
    expect(fmtPct(btc.share, { signed: false })).toBe('88.03%');
  });

  it('falls back to the USDC market when there is no USDT market', () => {
    const summary = valuePortfolio({
      balances: { SOL: { free: '2', used: '0', total: '2' } },
      markets,
      tickers: { 'SOL/USDC': ticker('SOL/USDC', '150.5', '140.5') },
      nowMs: NOW,
    });
    expect(summary.totalUsd).toBe('301');
    expect(summary.holdings[0]!.priceSymbol).toBe('SOL/USDC');
    expect(summary.change24hUsd).toBe('20');
  });

  it('a coin with no price is listed as unpriced and not counted', () => {
    const summary = valuePortfolio({
      balances: { ...balances, DOGE: { free: '5', used: '0', total: '5' }, EUR: { free: '10', used: '0', total: '10' } },
      markets,
      tickers,
      nowMs: NOW,
    });
    expect(summary.totalUsd).toBe('277784.7454');
    expect(summary.unpriced.sort()).toEqual(['DOGE', 'EUR']);
    const doge = summary.holdings.find((h) => h.asset === 'DOGE')!;
    expect(doge.usdValue).toBeNull();
    expect(doge.usdChange24h).toBeNull();
    expect(doge.share).toBeNull();
    expect(summary.holdings.slice(-2).map((h) => h.asset)).toEqual(['DOGE', 'EUR']);
  });

  it('a market with no last price leaves the coin unpriced, never zero', () => {
    const summary = valuePortfolio({
      balances: { BTC: { free: '1', used: '0', total: '1' } },
      markets,
      tickers: { 'BTC/USDT': ticker('BTC/USDT', null, '64000') },
      nowMs: NOW,
    });
    expect(summary.totalUsd).toBeNull();
    expect(summary.unpriced).toEqual(['BTC']);
    expect(fmtUsd(summary.totalUsd)).toBe('—');
  });

  it("today's change is unknown (null), not a partial sum, when a counted coin has no 24 h open", () => {
    const summary = valuePortfolio({
      balances,
      markets,
      tickers: { ...tickers, 'ETH/USDT': ticker('ETH/USDT', '2650.55', null) },
      nowMs: NOW,
    });
    expect(summary.totalUsd).toBe('277784.7454');
    expect(summary.change24hUsd).toBeNull();
    expect(summary.change24hPct).toBeNull();
    expect(summary.holdings.find((h) => h.asset === 'ETH')!.usdChange24h).toBeNull();
  });

  it('an empty wallet is exactly zero (the one case where 0 is the true answer)', () => {
    const summary = valuePortfolio({ balances: {}, markets, tickers, nowMs: NOW });
    expect(summary.totalUsd).toBe('0');
    expect(summary.change24hUsd).toBe('0');
    expect(summary.change24hPct).toBeNull();
    expect(summary.holdings).toEqual([]);
    expect(summary.unpriced).toEqual([]);
  });

  it('zero balances are not holdings', () => {
    const summary = valuePortfolio({
      balances: { BTC: { free: '0', used: '0', total: '0' }, USDT: { free: '5', used: '0', total: '5' } },
      markets,
      tickers,
      nowMs: NOW,
    });
    expect(summary.holdings.map((h) => h.asset)).toEqual(['USDT']);
  });

  it('adds with exact arithmetic where a float would drift', () => {
    const summary = valuePortfolio({
      balances: { USDT: { free: '0.1', used: '0', total: '0.1' }, USDC: { free: '0.2', used: '0', total: '0.2' } },
      markets: [],
      tickers: {},
      nowMs: NOW,
    });
    expect(summary.totalUsd).toBe('0.3'); // 0.1 + 0.2 === 0.30000000000000004 in floats
    const big = valuePortfolio({
      balances: { USDT: { free: '0', used: '0', total: '123456789012345678.123456789012345678' } },
      markets: [],
      tickers: {},
      nowMs: NOW,
    });
    expect(big.totalUsd).toBe('123456789012345678.123456789012345678');
  });

  it("flags a partial 'today' window when a counted market is under a day old", () => {
    const young = { ...tickers, 'IFC/USDT': ticker('IFC/USDT', '1.0036', '1', { windowStart: NOW - 3 * HOUR_MS }) };
    const summary = valuePortfolio({ balances, markets, tickers: young, nowMs: NOW });
    expect(summary.windowStart).toBe(NOW - 3 * HOUR_MS);
    expect(valuePortfolio({ balances, markets, tickers, nowMs: NOW }).windowStart).toBeNull();
  });

  it('values the real stack shape: BTC, ETH, IFC, USDC, USDT with USDT preferred', () => {
    const summary = valuePortfolio({ balances, markets, tickers, nowMs: NOW });
    expect(summary.holdings.filter((h) => h.priceSymbol?.endsWith('/USDC'))).toEqual([]);
  });
});
