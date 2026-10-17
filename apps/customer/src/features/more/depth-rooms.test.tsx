import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Campaigns } from './Campaigns';
import { LaunchJourney, LaunchParticipation } from './LaunchRooms';
import { MiningRooms } from './MiningRooms';
import { QuantLibrary } from './QuantLibrary';
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
  return { ...real, useSession: () => ({ session: null }) as unknown as ReturnType<typeof real.useSession> };
});

describe('rooms with no backing service', () => {
  it('Campaigns opens on a catalogue that says it cannot list, not on an empty list', () => {
    const html = renderToStaticMarkup(<Campaigns />);
    expect(html).toContain('No campaign can be listed');
    expect(html).toContain('not a list of zero campaigns');
    expect(html).not.toContain('Coming soon');
  });
  it('Launch lays out seven issuer steps and blocks all but the check and the draft', () => {
    const html = renderToStaticMarkup(<LaunchJourney onTab={() => undefined} />);
    expect((html.match(/depth-step depth-step--/g) ?? []).length).toBe(7);
    expect((html.match(/depth-step--blocked/g) ?? []).length).toBe(5);
    expect(html).toContain('Blocked: issuance is held');
  });
  it('Launch participation reads as unavailable, not zero', () => {
    const html = renderToStaticMarkup(<LaunchParticipation />);
    expect(html).toContain('Unavailable, not zero');
  });
  it('Mining overview shows the pool reading and blocks every customer step', () => {
    const html = renderToStaticMarkup(<MiningRooms room="Overview" health={ready(health)} />);
    expect(html).toContain('connections is not configured');
    expect((html.match(/depth-step--blocked/g) ?? []).length).toBe(4);
  });
  it('Mining workers and rewards disable what cannot run and show no figures', () => {
    for (const room of ['Workers', 'Shares', 'Rewards'] as const) {
      const html = renderToStaticMarkup(<MiningRooms room={room} health={ready(health)} />);
      expect(html).toContain('Unavailable, not zero');
    }
    expect(renderToStaticMarkup(<MiningRooms room="Workers" health={ready(health)} />)).toContain('disabled=""');
  });
  it('Quant library labels the strategies as memory-only, shared and simulated', () => {
    const html = renderToStaticMarkup(
      <QuantLibrary
        onPick={() => undefined}
        strategies={[
          {
            id: 's_1',
            name: 'Momentum',
            environment: 'paper',
            claimLabel: 'Paper — not live performance',
            cash: '1000',
            blocks: [{ side: 'buy', symbol: 'BTC-USD', qty: '1' }],
            risk: { maxDrawdown: '0.1', maxNotional: '500', kill: '0.2' },
          },
        ]}
      />,
    );
    expect(html).toContain('Held in memory only');
    expect(html).toContain('not private to your account');
    expect(html).toContain('Momentum');
    expect(html).toContain('Showing 1 of 1 loaded');
  });
});
