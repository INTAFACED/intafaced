import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LaunchLiquidityRoom } from './launch-liquidity-room';
import { MakerProgrammeRoom } from './maker-programme-room';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

// J-cex-spot-20 #8. TEST values only.
const stamp = { version: '1', operatorId: 'op-a', approverId: 'op-b', approvalId: 'appr-1', writtenAt: '2026-11-06T12:00:00.000Z' };
const MAKER = '55555555-5555-4555-8555-555555555555';

describe('maker programme room', () => {
  it('says plainly when there are no terms, members or clawbacks', () => {
    const html = renderToStaticMarkup(<MakerProgrammeRoom terms={null} members={[]} clawbacks={[]} />);
    expect(html).toContain('data-room="maker-programme"');
    expect(html).toMatch(/data-terms="" data-state="unset"/);
    expect(html).toContain('trade.maker_programme_term_unset');
    expect(html).toContain('No member admitted.');
    expect(html).toContain('No clawback recorded.');
    expect(html).toContain('Not connected');
    expect(html).not.toMatch(/\byet\b/i);
  });

  it('shows the terms tier by tier and every obligation', () => {
    const terms = {
      ...stamp,
      tiers: [{ name: 'TEST Gold', minMakerVolume30d: '1000000', minUptimePct: '97.5', maxSpreadAtDepthBps: '20', rebateBps: '3' }],
      maxSpreadBps: '50',
      minDepth: '25000',
      minUptimePct: '95',
      cancelToFillCeiling: '30',
      clawbackWindowDays: '90',
      equalAccessCriteria: 'TEST criteria',
    };
    const html = renderToStaticMarkup(
      <MakerProgrammeRoom
        terms={terms}
        members={[
          { ...stamp, accountId: MAKER, tier: 'TEST Gold', status: 'active', conflictDeclaration: 'TEST: none', termsVersion: '1' },
        ]}
        clawbacks={[]}
      />,
    );
    expect(html).toContain('data-tier="TEST Gold"');
    expect(html).toContain('<td data-col="rebate">3 bps</td>');
    expect(html).toContain('<dd data-obligation="clawback-window">90 days</dd>');
    expect(html).toContain('<dd data-obligation="cancel-ratio-ceiling">30</dd>');
    expect(html).toContain(`data-member="${MAKER}"`);
  });
});

describe('launch liquidity room', () => {
  it('shows one record per market: its plan, or no plan recorded', () => {
    const plan = {
      ...stamp,
      market: 'm1',
      symbol: 'IFC/USDC',
      state: 'approved' as const,
      makers: [{ accountId: MAKER, capital: '50000', asset: 'USDT' }],
      maxSpreadBps: '30',
      minDepth: '10000',
      depthBandBps: '50',
      minUptimePct: '95',
      inventoryMin: '-2.5',
      inventoryMax: '2.5',
      exitReviewDate: '2027-02-01',
      exitUptimeBelowPct: '80',
      exitSpreadAboveBps: '100',
    };
    const html = renderToStaticMarkup(
      <LaunchLiquidityRoom
        markets={[
          { market: 'm1', symbol: 'IFC/USDC', status: 'active', plan },
          { market: 'm2', symbol: 'BTC/USDT', status: 'active', plan: null },
        ]}
        members={[]}
      />,
    );
    expect(html).toMatch(/data-plan-market="IFC\/USDC" data-plan-state="approved"/);
    expect(html).toContain('<td data-col="min-depth">10000 within 50 bps</td>');
    expect(html).toContain('<td data-col="inventory-band">-2.5 to 2.5</td>');
    expect(html).toMatch(/data-plan-market="BTC\/USDT" data-plan-state="none"/);
    expect(html).toContain('No plan recorded');
  });
});
