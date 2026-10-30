import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import { BuybackRunsView, buybackRunsSchema, type BuybackRunsRead } from './BuybackRuns';

const html = (data: BuybackRunsRead) =>
  renderToStaticMarkup(
    <SessionProvider>
      <BuybackRunsView read={{ resource: { status: 'ready', data }, reload: () => undefined }} />
    </SessionProvider>,
  );
const run = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  bought: '1000.5',
  burned: '600.3',
  toRewards: '400.2',
  executedAt: '2026-10-02T00:00:00.000Z',
  windowFrom: '2026-10-01T00:00:00.000Z',
  windowTo: '2026-10-02T00:00:00.000Z',
};
const blankRate = { rate: null, missing: 'token_params.buyback_bps', reason: 'token.params_unset' } as const;

describe('burn page buyback runs', () => {
  it('shows each stored run as stored, with the job not set and no estimate while the rate is blank', () => {
    const out = html({ job: 'unset', runs: [run], ...blankRate });
    for (const header of ['Bought', 'Burned', 'Sent to rewards']) expect(out).toContain(`<th scope="col">${header}</th>`);
    expect(out).toContain('1,000.5');
    expect(out).toContain('600.3');
    expect(out).toContain('400.2');
    expect(out).toContain('Job not set');
    expect(out).toContain('data-testid="buyback-estimate">No estimate: the buyback rate is not set.</p>');
    expect(out).not.toContain('No buyback run has settled.');
  });

  it('with no settled run says so beside the empty table, and a set job reads as set', () => {
    const out = html({ job: 'set', runs: [], ...blankRate });
    expect(out).toContain('aria-label="Buyback runs"');
    expect(out).toContain('No buyback run has settled.');
    expect(out).toContain('Job set');
    expect(out).not.toContain('Job not set');
  });

  it('states a set rate and estimates no amount; an unreadable rate is not called unset', () => {
    const set = html({ job: 'unset', runs: [], rate: { buybackBps: 2500, burnSplitBps: 6000 }, missing: null, reason: null });
    expect(set).toContain('Buyback rate: 2,500 basis points of house fees per window. 6,000 basis points');
    expect(set).not.toContain('No estimate');
    const bad = html({ job: 'unset', runs: [], rate: null, missing: 'token_params', reason: 'token.params_invalid' });
    expect(bad).toContain('No estimate: the stored buyback rate cannot be read.');
  });

  it('refuses a read whose run does not add up, so it is never drawn', () => {
    const read = { job: 'unset', runs: [{ ...run, toRewards: '400.1' }], ...blankRate };
    expect(buybackRunsSchema.safeParse(read).success).toBe(false);
    expect(buybackRunsSchema.safeParse({ ...read, runs: [run] }).success).toBe(true);
  });
});
