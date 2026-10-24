// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { helpLibraryPath } from './help-library';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const world = vi.hoisted(() => ({
  answer: undefined as unknown as (procedure: string, input: unknown) => unknown,
  asked: [] as unknown[],
}));
vi.mock('../session/session', () => {
  const api = {
    query: async (_module: string, procedure: string, input: unknown) => {
      world.asked.push([procedure, input]);
      return world.answer(procedure, input);
    },
    mutate: async () => ({ ok: false }),
  };
  return { useApi: () => api, useSession: () => ({ api, userId: null, session: null }) };
});
vi.mock('../more/support-contact', () => ({
  useSupportContact: () => ({ status: 'ready', email: null, phone: null, chatHours: null }),
}));

import { HelpLibrary, HelpLibraryNav } from './HelpLibrary';

let host: HTMLDivElement, root: Root;
async function mount(node: React.ReactNode) {
  await act(async () => root.render(node));
  await act(async () => undefined);
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  world.asked = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const library = {
  categories: [
    {
      id: 'money',
      name: 'Money',
      position: 0,
      sections: [{ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 0, articleCount: 1 }],
    },
  ],
};

describe('help library paths (SP-kb-01)', () => {
  it('reads only /help/category/<id> and /help/section/<id>', () => {
    expect(helpLibraryPath('/help/category/money')).toEqual({ kind: 'category', id: 'money' });
    expect(helpLibraryPath('/help/section/withdrawals-1')).toEqual({ kind: 'section', id: 'withdrawals-1' });
    expect(helpLibraryPath('/help/category/')).toBeNull();
    expect(helpLibraryPath('/help/category/Money')).toBeNull();
    expect(helpLibraryPath('/help/section/a/b')).toBeNull();
    expect(helpLibraryPath('/help')).toBeNull();
  });
});

describe('the help library screens', () => {
  it('the front door says plainly when no topic is set up, and invents none', async () => {
    world.answer = () => ({ ok: true, data: { categories: [] } });
    await mount(<HelpLibraryNav />);
    expect(host.textContent).toContain('No topics have been set up.');
    expect(host.querySelectorAll('a')).toHaveLength(0);
  });

  it('a section page lists its answers as text, a tag in the body stays characters', async () => {
    world.answer = (procedure) =>
      procedure === 'kbSection'
        ? {
            ok: true,
            data: {
              category: { id: 'money', name: 'Money' },
              section: { id: 'withdrawals', name: 'Withdrawals' },
              articles: [
                {
                  id: 'withdraw-time',
                  titleKey: 'support.kb.stored.title',
                  bodyKey: 'support.kb.stored.body',
                  version: 1,
                  title: 'How long it takes',
                  body: 'A <b>tag</b> stays text.\n\nSecond paragraph.',
                  language: 'en',
                  sectionId: 'withdrawals',
                },
              ],
            },
          }
        : { ok: true, data: library };
    await mount(<HelpLibrary at={{ kind: 'section', id: 'withdrawals' }} />);
    expect(world.asked).toContainEqual(['kbSection', { sectionId: 'withdrawals', limit: 100 }]);
    expect(host.querySelector('h1')?.textContent).toBe('Withdrawals');
    expect(host.querySelector('.help__row p')?.textContent).toBe('A <b>tag</b> stays text.');
    expect(host.querySelector('b')).toBeNull();
    expect(host.querySelector('.help__row a')?.getAttribute('href')).toBe('/helpdetail?id=withdraw-time');
  });

  it('an empty section says so; a missing topic and a switched-off help centre have their own words', async () => {
    world.answer = () => ({
      ok: true,
      data: { category: { id: 'money', name: 'Money' }, section: { id: 'deposits', name: 'Deposits' }, articles: [] },
    });
    await mount(<HelpLibrary at={{ kind: 'section', id: 'deposits' }} />);
    expect(host.textContent).toContain('No answers in this section');

    world.answer = () => ({ ok: true, data: library });
    await mount(<HelpLibrary at={{ kind: 'category', id: 'gone' }} />);
    expect(host.querySelector('[data-testid="help-topic-missing"]')).not.toBeNull();

    world.answer = () => ({ ok: false, status: 412, reason: 'error', code: 'PRECONDITION_FAILED', message: 'support.help_centre_off' });
    await mount(<HelpLibrary at={{ kind: 'section', id: 'deposits-2' }} />);
    expect(host.querySelector('[data-testid="help-centre-off"]')).not.toBeNull();
  });
});
