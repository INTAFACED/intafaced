import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const { query, mutate } = vi.hoisted(() => ({
  query: vi.fn(() => new Promise(() => undefined)),
  mutate: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  const api = { query, mutate, canWrite: () => true };
  const session = { api, userId: 'a0000000-0000-4000-8000-000000000001', session: null };
  return { ...real, useSession: () => session as unknown as ReturnType<typeof real.useSession>, useApi: () => api as never };
});
import { Blueprint } from './Blueprint';
import { blueprintSessionCopy } from './blueprint-session-copy';

const render = () => {
  vi.stubGlobal('location', {
    pathname: '/blueprint',
    search: '',
    hash: '',
    origin: 'https://app.test',
    href: 'https://app.test/blueprint',
  });
  vi.stubGlobal('history', { length: 1, state: null });
  const html = renderToStaticMarkup(<Blueprint />);
  vi.unstubAllGlobals();
  return html;
};

it('keeps the guided session switched off with the real reason and no free-text answer boxes', () => {
  mutate.mockClear();
  const html = render();
  expect(html).toContain('The Blueprint service does not publish its question list');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Create your Blueprint<\/button>/);
  expect(html).toContain('<fieldset disabled');
  expect(html).not.toMatch(/Answer key|Your answer|Add answer/);
  expect(html).not.toMatch(/Neural Engine|customer API/);
  expect(mutate).not.toHaveBeenCalled();
});

it('labels the opt-in checkbox and shows readable visibility and size choices, not raw values', () => {
  const html = render();
  expect(html).toMatch(
    /<label class="blueprint-opt-in"><input type="checkbox"[^>]*\/><span>Opt in to mentor availability<\/span><\/label>/,
  );
  expect(html).toMatch(/<option value="private"[^>]*>Only me<\/option>/);
  expect(html).toMatch(/<option value="public"[^>]*>Any signed-in account<\/option>/);
  expect(html).toMatch(/<option value="portrait"[^>]*>Portrait<\/option>/);
  expect(html).not.toMatch(/>private<|>portrait<|>landscape</);
});

it('says in all three languages what the visibility and mentor states mean', () => {
  for (const locale of ['en', 'es', 'fr'] as const) {
    const copy = blueprintSessionCopy.forLocale(locale);
    for (const key of ['private', 'crew', 'public', 'portrait', 'landscape', 'shortlisted', 'accepted', 'declined', 'ended'] as const)
      expect(copy.t(key), `${locale}:${key}`).not.toBe(key);
  }
});
