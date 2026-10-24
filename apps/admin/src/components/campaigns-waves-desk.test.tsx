import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CampaignsWavesDeskView } from './campaigns-waves-desk';
import type { WavesDeskView } from '@/lib/campaigns-ops/waves-browser';
import type { WavesState } from '@/lib/campaigns-ops/waves-model';

const ok = (over: Partial<WavesState> = {}): WavesDeskView => ({
  asOf: '2026-10-24T10:00:00.000Z',
  state: { kind: 'ok', data: { waveSize: 2, nextWave: 2, waiting: 5, waves: [], ...over } },
});
const render = (view: WavesDeskView | null) =>
  renderToStaticMarkup(<CampaignsWavesDeskView view={view} loading={false} userId="u1" onRefresh={() => undefined} />);

describe('waitlist waves desk', () => {
  it('shows the size, the waiting count, the read time and a release form for the next wave', () => {
    const html = render(ok());
    expect(html).toContain('data-testid="waves-waiting">5<');
    expect(html).toContain('10:00:00 UTC');
    expect(html).toContain('Release wave 2: the top 2 waiting');
    expect(html).toContain('RELEASE WAVE 2');
    expect(html).toContain('No wave has been released yet.');
  });

  it('a blank owner size names the setting and offers no release', () => {
    const html = render(ok({ waveSize: null }));
    expect(html).toContain('IDENTITY_WAITLIST_WAVE_SIZE');
    expect(html).not.toContain('Release wave 2');
    expect(html).toContain('Release unavailable');
  });

  it('nobody waiting offers no release; released waves list operator ids', () => {
    const html = render(
      ok({
        waiting: 0,
        waves: [
          {
            waveNumber: 1,
            size: 2,
            releasedCount: 2,
            flagKey: 'waitlist.enabled',
            releasedBy: 'op-a',
            approvedBy: 'op-b',
            releasedAt: '2026-10-24T09:00:00.000Z',
          },
        ],
      }),
    );
    expect(html).toContain('Nobody is waiting');
    expect(html).toContain('op-a');
    expect(html).toContain('op-b');
    expect(html).toContain('2 of 2');
  });

  it('a failed read says why and offers no form; no read at all shows no state', () => {
    const failed = render({
      asOf: '2026-10-24T10:00:00.000Z',
      state: { kind: 'failed', message: 'svc-identity did not answer.', code: null, notBuilt: false, forbidden: false },
    });
    expect(failed).toContain('svc-identity did not answer.');
    expect(failed).not.toContain('request-form');
    expect(render(null)).toContain('could not be read');
  });
});
