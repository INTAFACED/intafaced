// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const ID = '11111111-1111-4111-8111-111111111111';
const world = vi.hoisted(() => ({
  signedIn: false,
  awaiting: { ok: true, data: { count: 0, longestWaiting: null } } as unknown,
  query: undefined as unknown as (module: string, procedure: string, input?: unknown) => Promise<unknown>,
}));

vi.mock('../session/session', () => {
  const api = {
    query: (module: string, procedure: string, input?: unknown) => world.query(module, procedure, input),
    mutate: async () => ({ ok: false }),
  };
  return {
    useApi: () => api,
    useSession: () => ({
      api,
      userId: world.signedIn ? 'user-1' : null,
      session: world.signedIn ? { accessToken: 'token' } : null,
    }),
  };
});
vi.mock('../more/support-contact', () => ({
  useSupportContact: () => ({ status: 'ready', email: null, phone: null, chatHours: null }),
}));

import { PublicHelp } from './PublicHelp';

let host: HTMLDivElement, root: Root;
async function mount() {
  await act(async () => {
    root.render(<PublicHelp />);
  });
  await act(async () => undefined);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  history.replaceState(null, '', '/help');
  world.signedIn = false;
  world.awaiting = { ok: true, data: { count: 0, longestWaiting: null } };
  world.query = async (_module, procedure) =>
    procedure === 'awaitingMine'
      ? world.awaiting
      : procedure === 'kbLibrary'
        ? { ok: true, data: { categories: [] } }
        : { ok: true, data: [] };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('an article the reader may not see', () => {
  const asNull = () => {
    world.query = async (_module, procedure) => (procedure === 'getKb' ? { ok: true, data: null } : { ok: true, data: [] });
  };
  it('a signed-out reader gets the sign-in prompt, which names no article text', async () => {
    asNull();
    history.replaceState(null, '', '/helpdetail?id=kb-staff-only');
    await mount();
    const prompt = host.querySelector('[data-testid="help-sign-in"]');
    expect(prompt).not.toBeNull();
    expect(prompt?.querySelector('a')?.getAttribute('href')).toBe('/login?redirect=%2Fhelpdetail%3Fid%3Dkb-staff-only');
    expect(prompt?.textContent).not.toContain('kb-staff-only');
  });
  it('a signed-in reader reads it as not found, with no sign-in prompt', async () => {
    world.signedIn = true;
    asNull();
    history.replaceState(null, '', '/helpdetail?id=kb-staff-only');
    await mount();
    expect(host.querySelector('[data-testid="help-sign-in"]')).toBeNull();
    expect(host.textContent).toContain('No answer found');
  });
});

describe('the help centre front door', () => {
  it('a signed-out visitor who presses the request button sees the sign-in prompt, and the search text is kept', async () => {
    await mount();
    const search = host.querySelector<HTMLInputElement>('input[name="help-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'withdrawal limit');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="request-sign-in"]')).toBeNull();
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send a request')!;
    await act(async () => button.click());
    const prompt = host.querySelector('[data-testid="request-sign-in"]')!;
    expect(prompt.textContent).toContain('Sign in to send a request');
    expect(prompt.querySelector('a')!.getAttribute('href')).toBe('/login?redirect=%2Fsupport');
    expect(host.querySelector<HTMLInputElement>('input[name="help-search"]')!.value).toBe('withdrawal limit');
    expect(host.querySelector('[data-testid="action-required"]')).toBeNull();
    expect(host.innerHTML).not.toContain('mailto:');
  });

  async function searchFor(words: string) {
    const search = host.querySelector<HTMLInputElement>('input[name="help-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, words);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => search.form!.requestSubmit());
    await act(async () => undefined);
  }

  it('under a search with no answer, "Contact support" signs a visitor in and comes back to the form with the words as its subject (J-support-public-02 #1, #2)', async () => {
    await mount();
    await searchFor('lost phone');
    const empty = host.querySelector('.help__empty')!;
    const contact = [...empty.querySelectorAll('button')].find((b) => b.textContent === 'Contact support')!;
    await act(async () => contact.click());
    const prompt = host.querySelector('[data-testid="request-sign-in"]')!;
    expect(prompt.querySelector('a')!.getAttribute('href')).toBe('/login?redirect=%2Fsupport%2Fnew%3Fsubject%3Dlost%2Bphone');
    expect(host.querySelector<HTMLInputElement>('input[name="help-search"]')!.value).toBe('lost phone');
    // The request button at the top goes to the same form once the search found nothing.
    const top = [...host.querySelectorAll('.help__request button')].find((b) => b.textContent === 'Send a request')!;
    expect(top).toBeDefined();
  });

  it('signed in, "Contact support" links straight to the form with the words as its subject', async () => {
    world.signedIn = true;
    await mount();
    await searchFor('lost phone');
    const link = [...host.querySelectorAll<HTMLAnchorElement>('.help__empty a')].find((a) => a.textContent === 'Contact support')!;
    expect(link.getAttribute('href')).toBe('/support/new?subject=lost+phone');
    const desk = [...host.querySelectorAll<HTMLAnchorElement>('.help__request a')].find((a) => a.textContent === 'Contact support')!;
    expect(desk.getAttribute('href')).toBe('/support/new?subject=lost+phone');
  });

  it('a signed-in visitor with a request waiting sees the banner linking to that request', async () => {
    world.signedIn = true;
    world.awaiting = { ok: true, data: { count: 1, longestWaiting: { ticketId: ID, since: '2026-10-20T01:00:00.000Z' } } };
    await mount();
    const banner = host.querySelector('[data-testid="action-required"]')!;
    expect(banner.textContent).toContain('Action required');
    expect(banner.querySelector('a')!.getAttribute('href')).toBe(`/support/tickets/${ID}`);
    expect(host.textContent).toContain('Open your support requests');
    expect(host.querySelector('[data-testid="request-sign-in"]')).toBeNull();
  });

  it('says how many wait when more than one does', async () => {
    world.signedIn = true;
    world.awaiting = { ok: true, data: { count: 3, longestWaiting: { ticketId: ID, since: '2026-10-20T01:00:00.000Z' } } };
    await mount();
    expect(host.querySelector('[data-testid="action-required"]')!.textContent).toContain('3 support requests are waiting');
  });

  it('draws no banner when nothing waits', async () => {
    world.signedIn = true;
    await mount();
    expect(host.querySelector('[data-testid="action-required"]')).toBeNull();
    expect(host.querySelector('[data-testid="action-required-unread"]')).toBeNull();
  });

  it('a failed read says it could not check, never "nothing waiting"', async () => {
    world.signedIn = true;
    world.awaiting = { ok: false, reason: 'error', message: { key: 'loadFailed' } };
    await mount();
    expect(host.querySelector('[data-testid="action-required"]')).toBeNull();
    expect(host.querySelector('[data-testid="action-required-unread"]')!.textContent).toContain('could not check');
  });

  it('a signed-out visitor never asks for the waiting count', async () => {
    const asked: string[] = [];
    world.query = async (_m, procedure) => {
      asked.push(procedure);
      return procedure === 'kbLibrary' ? { ok: true, data: { categories: [] } } : { ok: true, data: [] };
    };
    await mount();
    expect(asked).not.toContain('awaitingMine');
  });

  it('a search shows the service ranking first, then the matches on this page, and carries the words to the desk', async () => {
    const answer = (id: string, title: string, body: string) => ({
      id,
      titleKey: 'support.kb.stored.title',
      bodyKey: 'support.kb.stored.body',
      title,
      body,
      language: 'en',
      published: true,
      version: 1,
    });
    const mentions = answer('passkey-mention', 'Signing in on a new phone', 'You can also add a passkey.');
    const labelled = answer('passkey-labelled', 'Use a security key', 'Hardware keys work as a second step.');
    const local = answer('passkey-local', 'Passkey basics', 'What it is.');
    const asked: unknown[] = [];
    world.query = async (_module, procedure, input) => {
      if (procedure === 'kbLibrary') return { ok: true, data: { categories: [] } };
      if (procedure !== 'searchKb') return { ok: true, data: [] };
      asked.push(input);
      const q = (input as { q: string }).q;
      return { ok: true, data: q ? [labelled, mentions] : [mentions, local, labelled] };
    };
    await mount();
    const search = host.querySelector<HTMLInputElement>('input[name="help-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'passkey');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLFormElement>('form.help__search')!.requestSubmit());
    await act(async () => undefined);
    expect(asked).toContainEqual({ q: 'passkey', limit: 100 });
    expect([...host.querySelectorAll('.help__row h2')].map((h) => h.textContent)).toEqual([
      'Use a security key',
      'Signing in on a new phone',
      'Passkey basics',
    ]);
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send a request')!;
    await act(async () => button.click());
    expect(host.querySelector('[data-testid="request-sign-in"] a')!.getAttribute('href')).toBe('/login?redirect=%2Fsupport%3Fq%3Dpasskey');
  });
});

describe('an answer in the languages the owner offers', () => {
  const stored = {
    id: 'withdraw-time',
    titleKey: 'support.kb.stored.title',
    bodyKey: 'support.kb.stored.body',
    title: 'How long a withdrawal takes',
    body: 'Paste <script>alert(1)</script> nowhere.',
    language: 'en',
    published: true,
    version: 1,
  };
  const settings = (languages: string[] | null) => ({
    name: null,
    address: null,
    defaultLanguage: null,
    languages,
    setupMode: null,
    published: null,
    revision: 1,
    updatedAt: null,
  });
  const open = async (languages: string[] | null) => {
    world.query = async (_module, procedure) =>
      procedure === 'getKb'
        ? { ok: true, data: stored }
        : procedure === 'helpCentre'
          ? { ok: true, data: settings(languages) }
          : { ok: true, data: [] };
    history.replaceState(null, '', '/helpdetail?id=withdraw-time');
    await mount();
  };

  it('offers a picker; another language shows the answer with a label naming the language it is shown in', async () => {
    await open(['en', 'es']);
    const picker = host.querySelector<HTMLSelectElement>('select[name="help-language"]')!;
    expect([...picker.options].map((o) => o.value)).toEqual(['en', 'es']);
    expect(host.querySelector('[data-testid="help-language-fallback"]')).toBeNull();
    await act(async () => {
      picker.value = 'es';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const label = host.querySelector('[data-testid="help-language-fallback"]')!;
    expect(label.textContent).toContain('Spanish');
    expect(label.textContent).toContain('English');
    expect(host.querySelector('.help__body')!.textContent).toContain('<script>alert(1)</script>');
    expect(host.querySelector('.help__body script')).toBeNull();
  });

  it('draws no picker while the owner offers no language', async () => {
    await open(null);
    expect(host.querySelector('select[name="help-language"]')).toBeNull();
    expect(host.querySelector('.help__body')!.textContent).toContain('Paste');
  });
});
