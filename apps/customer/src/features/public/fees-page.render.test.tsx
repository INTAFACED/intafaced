import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeesView } from './FeesPage';
import { bpsAsPercent, type PublicFeeSchedule } from './fees';

// SP-fees-vip-02 / J-cex-spot-10 #2: the public schedule by pair group and tier, a blank tier reading "not set", and
// the network fee as its own line. TEST rates only.
const schedule: PublicFeeSchedule = {
  version: 'v3',
  tiers: ['regular', 'vip-1'],
  groups: [
    {
      pairGroup: 'all-others',
      isDefault: true,
      symbols: ['BTC/USDT', 'ETH/USDT'],
      rows: [
        { tierId: 'regular', zeroFee: false, makerBps: 8, takerBps: 10, makerRebateBps: null, minFee: null },
        { tierId: 'vip-1', zeroFee: false, makerBps: 6, takerBps: 9, makerRebateBps: null, minFee: null },
      ],
    },
    {
      pairGroup: 'zero',
      isDefault: false,
      symbols: ['ETH/USDC'],
      rows: [{ tierId: 'regular', zeroFee: true, makerBps: 0, takerBps: 0, makerRebateBps: null, minFee: null }],
    },
  ],
};

const ready = (data: PublicFeeSchedule | null) => ({ status: 'ready' as const, data, asOf: 0 });

describe('/fees', () => {
  it('lists each pair group by tier, a blank tier as "not set", and the network fee on its own line', () => {
    const html = renderToString(<FeesView load={ready(schedule)} />);
    expect(html).toContain('data-room="fees"');
    expect(html).toContain('Schedule version v3');
    expect(html).toContain('Pair group: all-others');
    expect(html).toContain('Pairs: BTC/USDT, ETH/USDT');
    expect(html).toMatch(/<th scope="row">Regular<\/th><td>0\.08%<\/td><td>0\.10%<\/td>/);
    expect(html).toMatch(/<th scope="row">vip-1<\/th><td>0\.06%<\/td><td>0\.09%<\/td>/);
    // The zero group has no vip-1 row: blank, not the regular rate and not zero.
    expect(html).toMatch(/data-pair-group="zero"[\s\S]*<th scope="row">Regular<\/th><td>Zero fee<\/td><td>Zero fee<\/td>/);
    expect(html).toMatch(/data-pair-group="zero"[\s\S]*<th scope="row">vip-1<\/th><td>not set<\/td><td>not set<\/td>/);
    expect(html).toContain('Network fee on withdrawals: not set here');
  });

  it('an unpublished schedule says so and shows no rate', () => {
    const html = renderToString(<FeesView load={ready(null)} />);
    expect(html).toContain('The trading fee schedule is not set');
    expect(html).not.toMatch(/\d\.\d\d%/);
    expect(html).toContain('Network fee on withdrawals: not set here');
  });

  it('loading and a failed read', () => {
    expect(renderToString(<FeesView load={{ status: 'loading' }} />)).toContain('Loading the fee schedule');
    expect(renderToString(<FeesView load={{ status: 'error', retry: () => undefined }} />)).toContain('The fee schedule did not load.');
  });

  it('writes basis points as a percentage without a float', () => {
    expect(bpsAsPercent(0)).toBe('0.00%');
    expect(bpsAsPercent(8)).toBe('0.08%');
    expect(bpsAsPercent(125)).toBe('1.25%');
    expect(bpsAsPercent(9999)).toBe('99.99%');
  });
});
