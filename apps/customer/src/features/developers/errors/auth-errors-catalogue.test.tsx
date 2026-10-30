import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { AUTH_ERROR_CATALOGUE } from '@intafaced/contracts/auth-errors';
import { SessionProvider } from '../../session/session';
import { DevelopersRoutes } from '../DevelopersRoutes';
import { authErrorsCopy, causeKey, fixKey } from './auth-errors-copy';

const html = (path: string) =>
  renderToString(
    <SessionProvider>
      <DevelopersRoutes path={path} />
    </SessionProvider>,
  );

describe('auth error catalogue page', () => {
  it('the auth error catalogue draws one anchored row per contracts entry and links the permission table', () => {
    const page = html('/developers/errors/auth');
    expect(page).toContain('Authentication and permission errors');
    expect(page).not.toContain('DV-errors-02');
    expect(page).toContain('href="/developers/permissions"');
    const rows = [...page.matchAll(/<tr id="([^"]+)" data-cause="([^"]+)" data-code="([^"]+)"/g)].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual(AUTH_ERROR_CATALOGUE.map((e) => [e.anchor, e.cause, e.code]));
    for (const entry of AUTH_ERROR_CATALOGUE) expect(page).toContain(`<code>${entry.code}</code>`);
  });
  it('the auth error catalogue names each cause in its own words, in every written language', () => {
    for (const locale of ['en', 'es', 'fr'] as const) {
      const { t } = authErrorsCopy.forLocale(locale);
      const words = AUTH_ERROR_CATALOGUE.map((e) => t(causeKey(e.cause)));
      expect(new Set(words).size, locale).toBe(words.length);
    }
    // A reader finds a refusal's row by its cause word: each of these names exactly one row.
    const { t } = authErrorsCopy.forLocale('en');
    const rowText = (e: (typeof AUTH_ERROR_CATALOGUE)[number]) =>
      [e.code, e.intafacedCode, t(causeKey(e.cause)), t(fixKey(e.cause))].join(' ');
    for (const word of ['missing', 'wrong', 'revoked', 'expired', 'frozen', 'scope', 'tampered', 'already used'])
      expect(AUTH_ERROR_CATALOGUE.filter((e) => new RegExp(word, 'i').test(rowText(e))).length, word).toBe(1);
    expect(authErrorsCopy.coverage('es').missing).toEqual([]);
    expect(authErrorsCopy.coverage('fr').missing).toEqual([]);
  });
});
