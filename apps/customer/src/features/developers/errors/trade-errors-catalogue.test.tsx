import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { TRADE_ERROR_CATALOGUE } from '@intafaced/contracts/trade-errors';
import { SessionProvider } from '../../session/session';
import { DevelopersRoutes } from '../DevelopersRoutes';
import { developersRoute } from '../developers-model';
import { tradeErrorsCopy, causeKey } from './trade-errors-copy';

const html = (path: string) =>
  renderToString(
    <SessionProvider>
      <DevelopersRoutes path={path} />
    </SessionProvider>,
  );

describe('order error catalogue page', () => {
  it('is the errors section page, with one anchored row per contracts entry and a link to the auth catalogue', () => {
    expect(developersRoute('/developers/errors')).toEqual({ kind: 'section', id: 'errors' });
    const page = html('/developers/errors');
    expect(page).toContain('data-testid="developers-errors"');
    expect(page).not.toContain('DV-errors-01');
    expect(page).toContain('href="/developers/errors/auth"');
    const rows = [...page.matchAll(/<tr id="([^"]+)" data-cause="([^"]+)" data-code="([^"]+)"/g)].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual(TRADE_ERROR_CATALOGUE.map((e) => [e.anchor, e.cause, e.intafacedCode]));
    expect(rows.map(([anchor]) => anchor)).toContain('trade.validation_failed');
    for (const entry of TRADE_ERROR_CATALOGUE) expect(page).toContain(`<code>${entry.code}</code>`);
  });
  it('names each cause in its own words, in every written language', () => {
    for (const locale of ['en', 'es', 'fr'] as const) {
      const { t } = tradeErrorsCopy.forLocale(locale);
      const words = TRADE_ERROR_CATALOGUE.map((e) => t(causeKey(e.cause)));
      expect(new Set(words).size, locale).toBe(words.length);
    }
    expect(tradeErrorsCopy.coverage('es').missing).toEqual([]);
    expect(tradeErrorsCopy.coverage('fr').missing).toEqual([]);
  });
});
