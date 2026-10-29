import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Campaigns } from './Campaigns';
import { LaunchJourney, LaunchParticipation } from './LaunchRooms';
import { MiningRooms, RewardsView, SharesView, WorkersView } from './MiningRooms';
import type { Resource } from '../../shared/resource';
import type { MiningHealth } from './mining-journey';

const ready = (data: MiningHealth): { resource: Resource<MiningHealth>; reload: () => void } => ({
  resource: { status: 'ready', data },
  reload: () => undefined,
});
const health: MiningHealth = {
  ok: true,
  service: 'svc-mining-pool',
  ledger: { status: 'configured', code: 'mining.ledger_unprobed' },
  pg: { status: 'absent', code: 'mining.pg_unavailable' },
  jobs: [],
};

// Server rendering has no browser store; read the stored preferences once.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// The signed-out overview inside Campaigns reads the session.
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  const api = { query: () => new Promise(() => undefined), canWrite: () => true };
  return {
    ...real,
    useSession: () => ({ session: null }) as unknown as ReturnType<typeof real.useSession>,
    useApi: () => api as never,
  };
});

describe('rooms with no backing service', () => {
  it('Campaigns opens on the catalogue reading the published campaigns, not on an empty list', () => {
    const html = renderToStaticMarkup(<Campaigns />);
    expect(html).toContain('Reading the published campaigns');
    expect(html).not.toContain('No campaign can be listed');
    expect(html).not.toContain('Coming soon');
  });
  it('Launch lays out seven issuer steps and blocks all but the check and the draft', () => {
    const html = renderToStaticMarkup(<LaunchJourney onTab={() => undefined} />);
    expect((html.match(/depth-step depth-step--/g) ?? []).length).toBe(7);
    expect((html.match(/depth-step--blocked/g) ?? []).length).toBe(5);
    expect(html).toContain('Blocked: issuance is on hold');
  });
  it('Launch participation reads as unavailable, not zero', () => {
    const html = renderToStaticMarkup(<LaunchParticipation />);
    expect(html).toContain('Unavailable, not zero');
  });
  it('Mining overview shows the pool reading, blocks worker registration and points the other steps to their reads', () => {
    const html = renderToStaticMarkup(<MiningRooms room="Overview" health={ready(health)} />);
    expect(html).toContain('connections is not configured');
    expect((html.match(/depth-step--blocked/g) ?? []).length).toBe(1);
    expect((html.match(/depth-step--info/g) ?? []).length).toBe(3);
    expect(html).not.toContain('no way for customers');
  });
  it('Mining rooms say they are loading, not zero, until the pool answers', () => {
    for (const room of ['Workers', 'Shares', 'Rewards'] as const) {
      const html = renderToStaticMarkup(<MiningRooms room={room} health={ready(health)} />);
      expect(html).not.toContain('No records');
    }
    expect(renderToStaticMarkup(<MiningRooms room="Workers" health={ready(health)} />)).toContain('disabled=""');
  });
  it('Mining workers list what the pool returns, with exact weight and no hashrate unit', () => {
    const read = {
      resource: {
        status: 'ready' as const,
        data: {
          asOf: '2026-10-18T03:00:00.000Z',
          windowMinutes: 60,
          workers: [
            {
              id: 'w1',
              name: 'rig-a',
              createdAt: '2026-10-10T08:00:00.000Z',
              hashrate: '12345678901234567890',
              hashrateReason: null,
              minDifficulty: '512',
            },
            {
              id: 'w2',
              name: 'rig-b',
              createdAt: '2026-10-11T08:00:00.000Z',
              hashrate: null,
              hashrateReason: 'no_shares_in_window',
              minDifficulty: null,
            },
          ],
          defaultDifficulty: null,
          defaultDifficultyReason: 'mining.default_difficulty_unset',
          nextCursor: 'c1',
        },
      },
      reload: () => undefined,
    };
    const html = renderToStaticMarkup(<WorkersView read={read} minutes={60} onMinutes={() => undefined} />);
    expect(html).toContain('rig-a');
    expect(html).toContain('12,345,678,901,234,567,890');
    expect(html).toContain('No accepted shares in this window');
    expect(html).not.toMatch(/H\/s|hashes per second\b(?!,)/);
    expect(html).not.toContain('no_shares_in_window');
    // Opens /mining/workers and sets a minimum difficulty: the set minimum, "Automatic" where none, and a blank default says so.
    expect(html).toMatch(/<td class="numeric">512<\/td>/);
    expect(html).toMatch(/<td class="numeric">Automatic<\/td>/);
    expect(html).toContain('The pool has no published default difficulty.');
    expect(html).toContain('type="search"');
    expect(html).toContain('Next page');
    expect(html).not.toContain('First page');
    expect(html).toContain('Minimum difficulty');
    expect(html).toContain('does not apply it to the jobs it sends');
  });
  it('Mining workers show a published default difficulty, a refused one by name, and paging back', () => {
    const data = (defaultDifficulty: string | null, defaultDifficultyReason: string | null) => ({
      resource: {
        status: 'ready' as const,
        data: {
          asOf: '2026-10-18T03:00:00.000Z',
          windowMinutes: 60,
          workers: [],
          defaultDifficulty,
          defaultDifficultyReason,
          nextCursor: null,
        },
      },
      reload: () => undefined,
    });
    const set = renderToStaticMarkup(<WorkersView read={data('1024', null)} minutes={60} onMinutes={() => undefined} paged />);
    expect(set).toContain('Default difficulty for a worker with no minimum: 1024');
    expect(set).toContain('First page');
    expect(set).not.toContain('Next page');
    const invalid = renderToStaticMarkup(
      <WorkersView read={data(null, 'mining.default_difficulty_invalid')} minutes={60} onMinutes={() => undefined} />,
    );
    expect(invalid).toContain('not a whole number, so none is shown');
    expect(invalid).not.toContain('The pool has no published default difficulty.');
    expect(invalid).not.toContain('Default difficulty for a worker with no minimum');
    const none = renderToStaticMarkup(
      <WorkersView read={data(null, 'mining.default_difficulty_unset')} minutes={60} onMinutes={() => undefined} filter="zzz" />,
    );
    expect(none).toContain('No worker name matches this filter');
    expect(none).not.toContain('You have no workers yet');
  });
  it('Mining workers say so when the pool lists none', () => {
    const read = {
      resource: {
        status: 'ready' as const,
        data: {
          asOf: '2026-10-18T03:00:00.000Z',
          windowMinutes: 60,
          workers: [],
          defaultDifficulty: null,
          defaultDifficultyReason: 'mining.default_difficulty_unset',
          nextCursor: null,
        },
      },
      reload: () => undefined,
    };
    expect(renderToStaticMarkup(<WorkersView read={read} minutes={60} onMinutes={() => undefined} />)).toContain('You have no workers yet');
  });
  it('Mining shares add the windows exactly and number them instead of printing ids', () => {
    const read = {
      resource: {
        status: 'ready' as const,
        data: {
          asOf: '2026-10-18T03:00:00.000Z',
          windows: [
            { windowId: 'win_aaaa1111', acceptedCount: 3, rejectedCount: 1, acceptedWeight: '9007199254740993' },
            { windowId: 'win_bbbb2222', acceptedCount: 2, rejectedCount: 0, acceptedWeight: '7' },
          ],
        },
      },
      reload: () => undefined,
    };
    const html = renderToStaticMarkup(<SharesView read={read} />);
    expect(html).toContain('9,007,199,254,741,000');
    expect(html).toContain('Counted window 1');
    expect(html).toContain('Counted window 2');
    expect(html).not.toContain('win_aaaa1111');
  });
  it('Mining rewards show the fee, window size, an estimate labelled as one, and paid credits', () => {
    const ok = <T,>(data: T) => ({ resource: { status: 'ready' as const, data }, reload: () => undefined });
    const html = renderToStaticMarkup(
      <RewardsView
        terms={ok({ feeBps: 150, feeReason: null, windowSize: 1000, windowSizeReason: null })}
        pending={ok({
          asOf: '2026-10-18T03:00:00.000Z',
          windows: [
            {
              windowId: 'win_1',
              assetId: 'BTC',
              callerWeight: '10',
              totalWeight: '40',
              reward: '0.04',
              feeBps: 150,
              estimate: { estimate: true as const, estimatedGross: '0.00985' },
            },
          ],
        })}
        payouts={ok({
          asOf: '2026-10-18T03:00:00.000Z',
          nextCursor: null,
          payouts: [
            {
              windowId: 'win_0',
              minerId: 'm1',
              assetId: 'BTC',
              amount: '0.001',
              amountReason: null,
              paidAt: '2026-10-17T10:00:00.000Z',
              ledgerTransactionId: null,
              ledgerReason: 'mining.ledger_tx_unrecorded',
            },
          ],
        })}
      />,
    );
    expect(html).toContain('1.5%');
    expect(html).toContain('Window size (pool setting)</dt><dd>1,000</dd>');
    expect(html).toContain('0.00985 BTC');
    expect(html).toContain('An estimate');
    expect(html).toContain('0.001 BTC');
    expect(html).not.toContain('mining.ledger_tx_unrecorded');
    expect(html).not.toContain('win_0');
  });
  it('Mining rewards never count an unreadable payout as zero, and mark an unconfirmed ledger entry', () => {
    const ok = <T,>(data: T) => ({ resource: { status: 'ready' as const, data }, reload: () => undefined });
    const row = (amount: string | null, ledgerReason: string | null) => ({
      windowId: `w${amount}`,
      minerId: 'm1',
      assetId: 'BTC',
      amount,
      amountReason: amount === null ? 'mining.emission_unpublished' : null,
      paidAt: '2026-10-17T10:00:00.000Z',
      ledgerTransactionId: null,
      ledgerReason,
    });
    const view = (payouts: ReturnType<typeof row>[]) =>
      renderToStaticMarkup(
        <RewardsView
          terms={ok({ feeBps: 150, feeReason: null, windowSize: 1000, windowSizeReason: null })}
          pending={ok({ asOf: '2026-10-18T03:00:00.000Z', windows: [] })}
          payouts={ok({ asOf: '2026-10-18T03:00:00.000Z', nextCursor: null, payouts })}
        />,
      );
    const allMissing = view([row(null, null)]);
    expect(allMissing).not.toMatch(/Paid to you<\/dt><dd>0</);
    expect(allMissing).toContain('Paid to you</dt><dd>Unknown');
    const some = view([row('0.5', null), row(null, null)]);
    expect(some).toContain('0.5 BTC');
    expect(some).toContain('Some credits can’t be shown');
    expect(view([])).toContain('Paid to you</dt><dd>0');
    expect(view([row('0.5', 'mining.ledger_tx_unrecorded')])).toContain('Recorded, ledger entry not confirmed');
    expect(view([row('0.5', null)])).not.toContain('ledger entry not confirmed');
    expect(view([row('0.5', null)])).toContain('Window size (pool setting)</dt><dd>1,000</dd>');
  });
  it('Mining rewards keep the honest refusal when the pool does not answer', () => {
    const failed = {
      resource: {
        status: 'failed' as const,
        failure: { ok: false as const, reason: 'forbidden' as const, message: 'This account cannot read that.' },
      },
      reload: () => undefined,
    };
    const html = renderToStaticMarkup(<RewardsView terms={failed} pending={failed} payouts={failed} />);
    expect(html).toContain('This account cannot read that.');
    expect(html).not.toContain('Paid to you</dt><dd>0');
  });
});
