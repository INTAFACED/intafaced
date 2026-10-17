import { describe, expect, it } from 'vitest';
import {
  analyse,
  buildPreset,
  chartGeometry,
  legIssues,
  pnlAt,
  policyGaps,
  ticketBlock,
  ticketCost,
  timeLeft,
  UNLIMITED,
  type BlockInput,
  type Leg,
} from './model';

const leg = (side: Leg['side'], right: Leg['right'], strike: string, premium: string, qty = '1'): Leg => ({
  side,
  right,
  strike,
  qty,
  premium,
});

describe('legIssues', () => {
  it('flags missing and invalid fields, and allows a price of zero', () => {
    expect(legIssues(leg('buy', 'call', '', ''))).toEqual({ strike: 'missing', premium: 'missing' });
    expect(legIssues({ ...leg('buy', 'call', '0', '1'), qty: '-1' })).toEqual({ strike: 'invalid', qty: 'invalid' });
    expect(legIssues(leg('buy', 'call', '100', '0'))).toEqual({});
    expect(legIssues(leg('buy', 'call', '100', '-1'))).toEqual({ premium: 'invalid' });
  });
});

describe('payoff at expiry', () => {
  it('long call: loses the price below the strike, break-even at strike plus price, no cap', () => {
    const legs = [leg('buy', 'call', '100', '5')];
    expect(pnlAt(legs, '90')).toBe('-5');
    expect(pnlAt(legs, '100')).toBe('-5');
    expect(pnlAt(legs, '110')).toBe('5');
    const a = analyse(legs)!;
    expect(a.netPremium).toEqual({ kind: 'debit', amount: '5' });
    expect(a.maxProfit).toBe(UNLIMITED);
    expect(a.maxLoss).toBe('-5');
    expect(a.breakEvens).toEqual(['105']);
  });

  it('long put: best result at spot zero, break-even at strike minus price', () => {
    const a = analyse([leg('buy', 'put', '100', '4')])!;
    expect(a.maxProfit).toBe('96');
    expect(a.maxLoss).toBe('-4');
    expect(a.breakEvens).toEqual(['96']);
  });

  it('straddle: two break-evens, capped loss, unlimited profit', () => {
    const a = analyse([leg('buy', 'call', '100', '5'), leg('buy', 'put', '100', '4')])!;
    expect(a.netPremium).toEqual({ kind: 'debit', amount: '9' });
    expect(a.maxLoss).toBe('-9');
    expect(a.maxProfit).toBe(UNLIMITED);
    expect(a.breakEvens).toEqual(['91', '109']);
  });

  it('naked short call: unlimited loss, profit capped at the price received', () => {
    const a = analyse([leg('sell', 'call', '100', '5')])!;
    expect(a.maxLoss).toBe(UNLIMITED);
    expect(a.maxProfit).toBe('5');
    expect(a.netPremium).toEqual({ kind: 'credit', amount: '5' });
    expect(a.breakEvens).toEqual(['105']);
  });

  it('bull call spread: both ends capped', () => {
    const a = analyse([leg('buy', 'call', '100', '5'), leg('sell', 'call', '110', '2')])!;
    expect(a.netPremium).toEqual({ kind: 'debit', amount: '3' });
    expect(a.maxProfit).toBe('7');
    expect(a.maxLoss).toBe('-3');
    expect(a.breakEvens).toEqual(['103']);
  });

  it('iron condor from the preset, with prices typed in', () => {
    const preset = buildPreset('ironCondor', '100', '10')!;
    const prices = ['1', '3', '3', '1'];
    const legs = preset.map((l, i) => ({ ...l, premium: prices[i]! }));
    const a = analyse(legs)!;
    expect(a.netPremium).toEqual({ kind: 'credit', amount: '4' });
    expect(a.maxProfit).toBe('4');
    expect(a.maxLoss).toBe('-6');
    expect(a.breakEvens).toEqual(['86', '114']);
  });

  it('uses the contract size and quantity and stays exact on small decimals', () => {
    const legs = [leg('buy', 'call', '100', '0.1', '3')];
    expect(analyse(legs, '0.5')!.netPremium).toEqual({ kind: 'debit', amount: '0.15' });
    expect(pnlAt([leg('buy', 'call', '100', '0.1'), leg('sell', 'call', '100', '0.3')], '90')).toBe('0.2');
  });

  it('a break-even that does not divide evenly keeps 18 decimals, never a float', () => {
    const a = analyse([leg('buy', 'call', '100', '1'), leg('sell', 'call', '103', '0')])!;
    expect(a.breakEvens).toEqual(['101']);
    const b = analyse([leg('buy', 'call', '100', '1'), leg('sell', 'call', '103', '0.5'), leg('sell', 'call', '103', '0.25')])!;
    expect(b.breakEvens[0]).toMatch(/^\d+(\.\d{1,18})?$/);
  });

  it('returns null while a leg is incomplete', () => {
    expect(analyse([])).toBeNull();
    expect(analyse([leg('buy', 'call', '100', '')])).toBeNull();
    expect(pnlAt([leg('buy', 'call', '100', '1')], 'abc')).toBeNull();
  });

  it('builds a spot grid that covers every strike', () => {
    const a = analyse([leg('buy', 'put', '90', '1'), leg('buy', 'call', '110', '1')])!;
    const spots = a.rows.map((r) => r.spot);
    expect(spots).toEqual(['70', '90', '110', '130']);
    expect(a.rows[0]!.pnl).toBe('18');
  });
});

describe('presets', () => {
  it('fills structure only, with empty prices', () => {
    expect(buildPreset('straddle', '100', '10')).toEqual([
      { side: 'buy', right: 'call', strike: '100', qty: '1', premium: '' },
      { side: 'buy', right: 'put', strike: '100', qty: '1', premium: '' },
    ]);
    expect(buildPreset('bearPutSpread', '100', '10')!.map((l) => [l.side, l.strike])).toEqual([
      ['buy', '100'],
      ['sell', '90'],
    ]);
  });

  it('refuses a shape that would need a strike at or below zero, or unusable numbers', () => {
    expect(buildPreset('ironCondor', '15', '10')).toBeNull();
    expect(buildPreset('longCall', '', '10')).toBeNull();
    expect(buildPreset('longCall', '100', '0')).toBeNull();
  });
});

describe('ticket cost', () => {
  const base = { strike: '60000', price: '125.5', size: '2', contractSize: '0.1', base: 'BTC', quote: 'USDT', settle: 'USDT', fee: null };

  it('buy: premium = price x size x contract size, and that is the total', () => {
    const cost = ticketCost({ ...base, side: 'buy', right: 'call' })!;
    expect(cost.premium).toEqual({ amount: '25.1', asset: 'USDT' });
    expect(cost.collateral).toBeNull();
    expect(cost.total).toEqual({ amount: '25.1', asset: 'USDT' });
  });

  it('adds a known fee to a buy and leaves an unknown one out', () => {
    expect(ticketCost({ ...base, side: 'buy', right: 'call', fee: '0.05' })!.total.amount).toBe('25.15');
    expect(ticketCost({ ...base, side: 'buy', right: 'call' })!.fee).toBeNull();
  });

  it('sell call holds the underlying; sell put holds strike x size x contract size', () => {
    const call = ticketCost({ ...base, side: 'sell', right: 'call' })!;
    expect(call.collateral).toEqual({ amount: '0.2', asset: 'BTC' });
    expect(call.total).toEqual({ amount: '0.2', asset: 'BTC' });
    expect(call.direction).toBe('receive');
    const put = ticketCost({ ...base, side: 'sell', right: 'put' })!;
    expect(put.collateral).toEqual({ amount: '12000', asset: 'USDT' });
  });

  it('is null when a number is not usable', () => {
    expect(ticketCost({ ...base, side: 'buy', right: 'call', size: '0' })).toBeNull();
    expect(ticketCost({ ...base, side: 'buy', right: 'call', price: '' })).toBeNull();
  });
});

describe('ticket block', () => {
  const ok: BlockInput = {
    signedIn: true,
    pending: false,
    contract: { paper: true, open: true, complete: true, tick: '0.5', lot: '0.1' },
    allowed: { options: true, paper: true, live: false },
    size: '1',
    price: '10',
  };

  it('lets a valid paper order through', () => {
    expect(ticketBlock(ok)).toBeNull();
  });

  it('names the first reason in order', () => {
    expect(ticketBlock({ ...ok, signedIn: false })).toBe('signedOut');
    expect(ticketBlock({ ...ok, pending: true })).toBe('pending');
    expect(ticketBlock({ ...ok, contract: null })).toBe('noContract');
    expect(ticketBlock({ ...ok, contract: { ...ok.contract!, complete: false } })).toBe('termsIncomplete');
    expect(ticketBlock({ ...ok, allowed: { options: false, paper: false, live: false } })).toBe('policyOff');
    expect(ticketBlock({ ...ok, contract: { ...ok.contract!, paper: false } })).toBe('liveBlocked');
    expect(ticketBlock({ ...ok, contract: { ...ok.contract!, open: false } })).toBe('marketClosed');
    expect(ticketBlock({ ...ok, size: '' })).toBe('size');
    expect(ticketBlock({ ...ok, price: '0' })).toBe('price');
    expect(ticketBlock({ ...ok, size: '0.15' })).toBe('sizeStep');
    expect(ticketBlock({ ...ok, price: '10.2' })).toBe('priceStep');
  });

  it('allows a live contract only when the policy allows live orders', () => {
    const live = { ...ok.contract!, paper: false };
    expect(ticketBlock({ ...ok, contract: live, allowed: { options: true, paper: true, live: true } })).toBeNull();
    expect(ticketBlock({ ...ok, allowed: null })).toBe('policyOff');
  });
});

describe('policy gaps and time left', () => {
  it('lists what the settlement policy still lacks', () => {
    expect(policyGaps({ settlementAssetLawStamped: false, settlementFixingConfigured: false })).toEqual(['settlement', 'fixing']);
    expect(policyGaps({ settlementAssetLawStamped: true, settlementFixingConfigured: true })).toEqual([]);
  });

  it('counts down and stops at expiry', () => {
    const now = Date.parse('2026-12-01T00:00:00Z');
    expect(timeLeft('2026-12-04T04:30:00Z', now)).toBe('3d 4h');
    expect(timeLeft('2026-12-01T05:10:00Z', now)).toBe('5h 10m');
    expect(timeLeft('2026-12-01T00:00:20Z', now)).toBe('1m');
    expect(timeLeft('2026-11-30T00:00:00Z', now)).toBeNull();
    expect(timeLeft(null, now)).toBeNull();
    expect(timeLeft('nonsense', now)).toBeNull();
  });
});

describe('chart geometry', () => {
  it('maps the payoff into whole-number chart units with profit up', () => {
    const a = analyse([leg('buy', 'call', '100', '5')])!;
    const g = chartGeometry(a.rows, 1000, 300)!;
    const points = g.line.split(' ').map((p) => p.split(','));
    expect(points[0]![0]).toBe('0');
    expect(points[points.length - 1]![0]).toBe('1000');
    expect(points[0]![1]).toBe('300');
    expect(points[points.length - 1]![1]).toBe('0');
    expect(g.zeroY).not.toBeNull();
    expect(g.line).not.toMatch(/[.e]/);
  });

  it('is null with fewer than two points', () => {
    expect(chartGeometry([])).toBeNull();
  });
});
