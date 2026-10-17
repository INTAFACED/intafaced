import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { PredictionTicket } from './PredictionTicket';
import type { PublishedOutcome } from './prediction-catalogue';

const market: PublishedOutcome = {
  id: 'evt-1',
  kind: 'outcome',
  question: 'Will it rain?',
  closeAt: '2027-01-01T00:00:00Z',
  settlementAssetId: 'USDT',
  settlementSource: 'source',
  collateralization: 'full',
  instruments: [
    { outcome: 'yes', symbol: 'EVT-1-YES' },
    { outcome: 'no', symbol: 'EVT-1-NO' },
  ],
};

describe('prediction ticket', () => {
  const page = renderToString(<PredictionTicket market={market} outcome="yes" />);

  it('shows the whole ticket with the INTACORE reason and no House wording', () => {
    expect(page).toContain('Prediction markets run on INTACORE, which is not activated yet.');
    expect(page).toContain('Number of contracts');
    expect(page).toContain('Review order');
    expect(page).not.toContain('House');
  });

  it('switches every field and button off', () => {
    const controls = page.match(/<(input|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThanOrEqual(6);
    for (const control of controls) expect(control).toContain('disabled');
  });
});
