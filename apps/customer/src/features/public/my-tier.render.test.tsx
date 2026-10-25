import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MyTierView } from './MyTierPage';
import { feeTierSchema, type FeeTier } from './fee-tier';

// SP-fees-vip-03 / J-cex-spot-10 #5-#6: the person's tier, the counted volume and what it reaches, the next threshold,
// the next snapshot, what is counted and excluded, and the snapshot rows. TEST thresholds only.
const SNAPSHOT = {
  key: 'tier-snapshot:2026-10-24T07:00Z:11111111-1111-4111-8111-111111111111',
  instant: '2026-10-24T07:00:00.000Z',
  tierId: 'test-vip-1',
  volume30d: '1250.5',
  countedFills: 4,
  scheduleVersion: 'v7',
};
const tier: FeeTier = feeTierSchema.parse({
  tier: 'test-vip-1',
  scheduleVersion: 'v7',
  program: {
    thresholds: [
      { tierId: 'test-vip-1', minVolume30d: '1000' },
      { tierId: 'test-vip-2', minVolume30d: '5000' },
    ],
    volumeQuotes: ['USDT', 'USDC'],
    snapshotTimeUtc: '07:00',
    benefits: null,
    downgradeGraceDays: null,
    subAccounts: null,
    botsAndCopy: null,
    assets: null,
  },
  volume: { amount: '1300', fills: 5, from: '2026-09-24T09:00:00.000Z', to: '2026-10-24T09:00:00.000Z', reaches: 'test-vip-1' },
  next: { tierId: 'test-vip-2', minVolume30d: '5000', remaining: '3700' },
  snapshotsRunning: true,
  nextSnapshotAt: '2026-10-25T07:00:00.000Z',
  lastSnapshot: SNAPSHOT,
  snapshots: [SNAPSHOT],
  excluded: ['other_quotes', 'futures_and_options', 'bots_and_copy', 'sub_accounts', 'assets'],
});
const ready = (data: FeeTier | null) => ({ status: 'ready' as const, data, asOf: 0 });

describe('/fees/my-tier', () => {
  it('shows the tier, the counted volume, the next threshold, the next snapshot, the exclusions and the snapshot rows', () => {
    const html = renderToString(<MyTierView load={ready(tier)} />);
    expect(html).toContain('data-room="my-tier"');
    expect(html).toContain('Your tier: test-vip-1');
    expect(html).toContain('From the snapshot at 2026-10-24 07:00 UTC');
    expect(html).toContain('1300 counted toward the next snapshot so far, from 5 trades');
    expect(html).toContain('At the next snapshot this volume reaches: test-vip-1');
    expect(html).toContain('Next tier: test-vip-2 from 5000, 3700 to go');
    expect(html).toContain('Next snapshot: 2026-10-25 07:00 UTC');
    expect(html).toContain('No grace period set');
    expect(html).toContain('Counted: your own spot trades quoted in USDT, USDC');
    expect(html).toContain('Bots, algorithmic orders and copy trading: not counted (no rule set).');
    expect(html).toContain('Assets you hold: not counted (no asset thresholds set).');
    expect(html).toMatch(
      /data-snapshot="tier-snapshot:2026-10-24T07:00Z:[^"]+"><th scope="row">2026-10-24 07:00 UTC<\/th><td>test-vip-1<\/td><td>1250\.5<\/td><td>4<\/td><td>v7<\/td>/,
    );
  });

  it('lists the published benefits by tier, marks the person\'s own row, and says "not set" for a blank cell', () => {
    const blank = { prioritySupport: null, vipPortal: null, ambassador: null, subAccountCap: null, withdrawalLimit24h: null };
    const withBenefits = feeTierSchema.parse({
      ...tier,
      program: {
        ...tier.program,
        // Out of tier order, and no row for test-vip-2: the page lists every tier lowest first, a missing row "not set".
        benefits: [
          {
            ...blank,
            tierId: 'test-vip-1',
            prioritySupport: true,
            vipPortal: false,
            subAccountCap: 20,
            withdrawalLimit24h: { asset: 'USDT', amount: '250000' },
          },
          { tierId: 'regular', ...blank },
        ],
      },
    });
    const html = renderToString(<MyTierView load={ready(withBenefits)} />);
    expect(html).toContain('VIP benefits');
    expect(html).toMatch(/data-benefits="regular"><th scope="row">Regular<\/th><td data-benefit="prioritySupport">not set<\/td>/);
    expect(html).toMatch(/data-benefits="test-vip-1" aria-current="true"><th scope="row">test-vip-1 \(yours\)<\/th>/);
    expect(html).toContain(
      '<td data-benefit="prioritySupport">Yes</td><td data-benefit="vipPortal">No</td><td data-benefit="ambassador">not set</td>',
    );
    expect(html).toContain('<td data-benefit="subAccountCap">20</td><td data-benefit="withdrawalLimit24h">up to 250000 USDT</td>');
    expect(html.indexOf('data-benefits="regular"')).toBeLessThan(html.indexOf('data-benefits="test-vip-1"'));
    expect(html).toMatch(/data-benefits="test-vip-2"><th scope="row">test-vip-2<\/th><td data-benefit="prioritySupport">not set<\/td>/);
  });

  it('names a VIP trial the tier comes from, and until when', () => {
    const trial = feeTierSchema.parse({
      ...tier,
      tier: 'test-vip-2',
      lastSnapshot: null,
      trial: {
        applicationId: '55555555-5555-4555-8555-555555555555',
        tierId: 'test-vip-2',
        startsAt: '2026-10-25T03:00:00.000Z',
        endsAt: '2026-11-24T03:00:00.000Z',
      },
    });
    const html = renderToString(<MyTierView load={ready(trial)} />);
    expect(html).toContain('Your tier: test-vip-2');
    expect(html).toContain('From your VIP trial, until 2026-11-24 03:00 UTC.');
    expect(html).not.toContain('From the snapshot at');
  });

  it('says the benefits are not set when the owner published no table', () => {
    expect(renderToString(<MyTierView load={ready(tier)} />)).toContain(
      'Benefits not set: no tier has published benefits beyond its rates.',
    );
  });

  it('with no thresholds says so and shows everyone regular, and with no snapshot time says none runs', () => {
    const none = renderToString(
      <MyTierView
        load={ready({
          ...tier,
          tier: 'regular',
          program: null,
          volume: null,
          next: null,
          nextSnapshotAt: null,
          lastSnapshot: null,
          snapshots: [],
        })}
      />,
    );
    expect(none).toContain('Your tier: Regular');
    expect(none).toContain('Thresholds not set. Every account is on the regular tier.');
    expect(none).toContain('No snapshot has included you yet.');
    expect(none).not.toContain('Counted volume');

    const untimed = renderToString(
      <MyTierView load={ready({ ...tier, program: { ...tier.program!, snapshotTimeUtc: null }, nextSnapshotAt: null })} />,
    );
    expect(untimed).toContain('No snapshot time set: no snapshot runs');
    const stopped = renderToString(<MyTierView load={ready({ ...tier, snapshotsRunning: false, nextSnapshotAt: null })} />);
    expect(stopped).toContain('Snapshots are not running');
  });

  it('an unpublished schedule says so', () => {
    expect(renderToString(<MyTierView load={ready(null)} />)).toContain('The trading fee schedule is not set');
  });
});
