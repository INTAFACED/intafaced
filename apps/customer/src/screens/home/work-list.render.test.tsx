import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkList as List } from './work-list';

const state = vi.hoisted(() => ({ language: 'en' as string, list: null as unknown }));

// Server rendering has no browser store; the page's language comes from the test.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => ({ ...real.currentPreferences(), language: state.language }) };
});
vi.mock('./work-list-data', () => ({ useWorkList: () => ({ list: state.list, retry: () => {} }) }));

import { WorkList } from './WorkList';

const empty: List = { state: 'ready', items: [], more: 0, ordered: true, missing: [] } as unknown as List;
// The sentence's own span: <span lang=".." dir=".." data-i18n="home.<key>">.
const span = (html: string, key: string) => new RegExp(`<span [^>]*data-i18n="[^"]*\\.${key}"[^>]*>`).exec(html)?.[0] ?? '';

describe('"Needs you" empty state on a right-to-left page', () => {
  it('keeps an English sentence left to right, so its full stop stays at the end', () => {
    state.list = empty;
    state.language = 'ar';
    const html = renderToString(<WorkList hidden={false} />);
    expect(span(html, 'Work nothing')).toContain('lang="en"');
    expect(span(html, 'Work nothing')).toContain('dir="ltr"');
    expect(html).toMatch(/<p class="home-work__none"[^>]*><span [^>]*>Nothing needs you right now\.<\/span><\/p>/);
  });

  it('marks a translated sentence with its own language', () => {
    state.list = empty;
    state.language = 'es';
    const html = renderToString(<WorkList hidden={false} />);
    expect(span(html, 'Work nothing')).toContain('lang="es"');
    expect(span(html, 'Work nothing')).toContain('dir="ltr"');
    expect(html).toContain('Nada te necesita ahora mismo.');
  });

  it('does the same for "nothing so far" and the note naming an owner that has not answered', () => {
    state.list = { ...empty, missing: [{ source: 'pay', state: 'unwired' }] } as unknown as List;
    state.language = 'ar';
    const html = renderToString(<WorkList hidden={false} />);
    for (const key of ['Work nothing so far', 'Work sources unwired']) {
      expect(span(html, key), key).toContain('lang="en"');
      expect(span(html, key), key).toContain('dir="ltr"');
    }
  });
});
