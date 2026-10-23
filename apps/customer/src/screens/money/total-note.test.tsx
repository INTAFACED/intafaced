import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { DerivedTotalNote, DerivedTotalTag, totalNoteCopy } from './total-note';
import { fromDerived, fromServer } from './portfolio-source';
import { valuePortfolio } from '../../data/derive';

const derived = fromDerived(
  valuePortfolio({ balances: { USDT: { free: '100', used: '0', total: '100' } }, markets: [], tickers: {}, nowMs: 1 }),
);
const server = fromServer({
  totalUsd: '100',
  change24hUsd: null,
  cashUsd: '100',
  cryptoUsd: '0',
  priced: [{ asset: 'USDT', amount: '100', priceUsd: '1', valueUsd: '100', change24hUsd: null, pair: null }],
  unpriced: [],
  asOf: 1,
  windowStart: null,
});

describe('total built on this device says named spaces are missing', () => {
  it('shows the line for a derived view, even for a cash-only account with no change line', () => {
    const html = renderToString(<DerivedTotalNote source={derived.source} className="home-note" />);
    expect(html).toContain('Named spaces aren’t included right now, so this total may be lower than your full balance.');
  });
  it('shows nothing for the bank’s own total', () => {
    expect(renderToString(<DerivedTotalNote source={server.source} className="home-note" />)).toBe('');
  });
  it('the short tag Home uses keeps the full sentence behind its tip, and is empty for the bank’s total', () => {
    const html = renderToString(<DerivedTotalTag source={derived.source} className="home-change__tag" />);
    expect(html).toContain('Named spaces not included');
    expect(html).toContain('Named spaces aren’t included right now, so this total may be lower than your full balance.');
    expect(renderToString(<DerivedTotalTag source={server.source} className="home-change__tag" />)).toBe('');
  });
  it('has es and fr words', () => {
    expect(totalNoteCopy.forLocale('es').t('namedSpacesMissing')).toMatch(/espacios con nombre/);
    expect(totalNoteCopy.forLocale('fr').t('namedSpacesMissing')).toMatch(/espaces nommés/);
    expect(totalNoteCopy.forLocale('es').t('namedSpacesShort')).toMatch(/Espacios con nombre/);
    expect(totalNoteCopy.forLocale('fr').t('namedSpacesShort')).toMatch(/Espaces nommés/);
  });
});
