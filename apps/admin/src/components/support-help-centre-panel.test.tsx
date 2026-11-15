import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SupportHelpCentre, SupportHelpCentreTranslationList } from '@intafaced/contracts';
import type { HelpCentreDeskView } from '@/lib/support/help-centre-server';
import { HelpCentrePanel } from './support-help-centre-panel';

const AS_OF = '2026-11-12T01:00:00.000Z';
const blank: SupportHelpCentre = {
  name: null,
  address: null,
  defaultLanguage: null,
  languages: null,
  setupMode: null,
  theme: null,
  published: null,
  revision: 0,
  updatedAt: null,
};
const ok = <T,>(data: T) => ({ kind: 'ok' as const, data });
const view = (settings: SupportHelpCentre, translations: SupportHelpCentreTranslationList): HelpCentreDeskView => ({
  asOf: AS_OF,
  settings: ok(settings),
  translations: ok(translations),
});
const html = (v: HelpCentreDeskView) => renderToStaticMarkup(<HelpCentrePanel view={v} />);

describe('HelpCentrePanel', () => {
  it('with nothing set says so for each value, counts no gap and draws no picker', () => {
    const out = html(view(blank, { languages: null, total: null, rows: [] }));
    expect(out).toContain('data-testid="help-centre-name">Not set<');
    expect(out).toContain('data-testid="help-centre-theme">Not set<');
    expect(out).toContain('Languages are not set');
    expect(out).toContain('Languages are not set, so no translation gap is counted.');
    expect(out).not.toContain('<select');
    expect(out).not.toContain('help-centre-missing-row');
  });

  it('shows the service’s name, theme and languages, and lists only the missing translations', () => {
    const settings = { ...blank, name: 'TEST Help', theme: 'dark' as const, languages: ['en', 'es'], revision: 3, updatedAt: AS_OF };
    const out = html(
      view(settings, {
        languages: ['en', 'es'],
        total: 4,
        rows: [
          { articleId: 'a', version: 1, language: 'en', state: 'translated' },
          { articleId: 'a', version: 1, language: 'es', state: 'missing' },
        ],
      }),
    );
    expect(out).toContain('data-testid="help-centre-name">TEST Help<');
    expect(out).toContain('data-testid="help-centre-theme">Dark<');
    expect(out).toContain('en, es');
    expect(out).not.toContain('Languages are not set');
    expect(out).toContain('1 missing in the first 2 of 4 article versions × languages.');
    expect(out.match(/help-centre-missing-row/g)).toHaveLength(1);
    expect(out).toContain('a version 1 · es · missing');
    expect(out).not.toContain('a version 1 · en');
  });

  it('a read that failed says so instead of showing a guess', () => {
    const failed = { kind: 'failed' as const, message: 'svc-support did not answer.', code: null, notBuilt: false, forbidden: false };
    const out = html({ asOf: AS_OF, settings: failed, translations: failed });
    expect(out).toContain('Help centre settings unavailable');
    expect(out).toContain('Translations unavailable');
    expect(out).not.toContain('help-centre-name');
    expect(out).not.toContain('help-centre-missing-none');
  });
});
