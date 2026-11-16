import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { POINTS_TIER_OWNER_QUESTION } from '@intafaced/contracts/campaigns-catalogue';
import { feeTierSchema, type FeeTier } from '../public/fee-tier';
import { PerksView } from './PerksRoom';

// J-campaigns-14 #1 #2 #4: the tier on spend with its multiplier and the next tier, the pass badge with its end time while
// a pass is in force, the badge gone and the pass's end on its row after it ends, and the points-basis tier's blocker.
const PASS = {
  passKey: 'trial-pass:cmp_test:11111111-1111-4111-8111-111111111111',
  campaignId: 'cmp_test',
  tierId: 'test-vip-1',
  startsAt: '2026-11-16T03:00:00.000Z',
  endsAt: '2026-11-16T03:02:00.000Z',
  grantedAt: '2026-11-16T03:00:00.000Z',
  endedAt: null,
  endReason: null,
  replacedBy: null,
};
const tier = (over: Partial<FeeTier> = {}): FeeTier =>
  feeTierSchema.parse({
    tier: 'regular',
    scheduleVersion: 'v-test',
    program: {
      thresholds: [{ tierId: 'test-vip-1', minVolume30d: '1000' }],
      volumeQuotes: ['USDT'],
      snapshotTimeUtc: null,
      benefits: null,
      downgradeGraceDays: null,
      subAccounts: null,
      botsAndCopy: null,
      assets: null,
    },
    volume: { amount: '0', fills: 0, from: '2026-10-17T03:00:00.000Z', to: '2026-11-16T03:00:00.000Z', reaches: 'regular' },
    next: { tierId: 'test-vip-1', minVolume30d: '1000', remaining: '1000' },
    snapshotsRunning: false,
    nextSnapshotAt: null,
    lastSnapshot: null,
    trial: null,
    pass: null,
    passes: [],
    rates: [
      { tierId: 'regular', makerBps: 8, takerBps: 10, takerMultiplier: '1' },
      { tierId: 'test-vip-1', makerBps: 6, takerBps: 9, takerMultiplier: '0.9' },
    ],
    snapshots: [],
    excluded: [],
    ...over,
  });
const ready = (data: FeeTier) => renderToString(<PerksView load={{ status: 'ready', data } as never} />).replace(/<!-- -->/g, '');

describe('/uc/promotion/perks', () => {
  it('shows the tier on spend, its multiplier, the next tier and the points-basis blocker, with no pass', () => {
    const html = ready(tier());
    expect(html).toContain('data-tier="regular"');
    expect(html).toContain('data-multiplier="1"');
    expect(html).toContain('test-vip-1 from 1000, 1000 to go');
    expect(html).toContain('No trial pass is in force.');
    expect(html).toContain('data-code="owner.decision"');
    expect(html).toContain(POINTS_TIER_OWNER_QUESTION.replace(/'/g, '&#x27;'));
  });

  it('shows the pass badge with its end time and the pass tier while a pass is in force', () => {
    const html = ready(tier({ tier: 'test-vip-1', next: null, pass: PASS, passes: [PASS] }));
    expect(html).toContain(`data-pass="${PASS.passKey}"`);
    expect(html).toContain('2026-11-16 03:02:00 UTC');
    expect(html).toContain('data-multiplier="0.9"');
    expect(html).toContain('You are at the top tier.');
  });

  it('drops the badge when the pass has ended and says on its row how it ended', () => {
    const ended = { ...PASS, endedAt: PASS.endsAt, endReason: 'expired' as const };
    const html = ready(tier({ pass: null, passes: [ended] }));
    expect(html).not.toContain('data-testid="perks-pass-badge"');
    expect(html).toContain('data-end="expired"');
    expect(html).toContain('Ended at its end time');
  });

  it('says thresholds are not set when there is no programme, and the multiplier is not set without rates', () => {
    const html = ready(tier({ program: null, next: null, rates: null }));
    expect(html).toContain('Thresholds not set');
    expect(html).toContain('Not set: the fee schedule has no rate');
  });
});
