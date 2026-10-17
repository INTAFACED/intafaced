import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const { query, mutate } = vi.hoisted(() => ({
  query: vi.fn(() => new Promise(() => undefined)),
  mutate: vi.fn(() => new Promise(() => undefined)),
}));

// Server rendering has no browser store; read the stored preferences once.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// The room reads the signed-in session; give it a service that records every call.
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  const api = { query, mutate, canWrite: () => true };
  const session = { api, userId: 'a0000000-0000-4000-8000-000000000001', session: null };
  return { ...real, useSession: () => session as unknown as ReturnType<typeof real.useSession>, useApi: () => api as never };
});
import { Quant } from './Quant';
import { readsSharedLibrary } from './quant-draft';
import { QuantLibraryClosed, QuantSaveOff } from './QuantSaveOff';
import { QuantMemoryNotice } from './QuantMemoryNotice';
import { QuantLibrary } from './QuantLibrary';

it('keeps "Save to library" on the form, switched off, with the reason beside it', () => {
  const html = renderToStaticMarkup(<QuantSaveOff />);
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Save to library<\/button>/);
  expect(html).toContain('aria-describedby="quant-save-off-reason"');
  expect(html).toContain('Saving to a library is off on this service. Your draft stays on this device.');
  expect(html).toContain('kept in this browser only');
});

it('says on the page that saving is off and why, without talking about servers', () => {
  const html = renderToStaticMarkup(<QuantMemoryNotice />);
  expect(html).toContain('Saving to a library is off on this service');
  expect(html).toContain('Your draft stays on this device.');
  expect(html).not.toMatch(/restart|version history|not private|shares one library/i);
  expect(html).not.toMatch(/database|quant service/i);
});

it('the library says it is shared and that saving is off', () => {
  const html = renderToStaticMarkup(<QuantLibrary strategies={[]} onPick={() => undefined} />);
  expect(html).toContain('Shared library');
  expect(html).toContain('Everyone using this service sees the same strategies here.');
  expect(html).toContain('Saving to a library is off on this service');
});

it('the library panel in Studio is closed with a plain reason and no rows', () => {
  const html = renderToStaticMarkup(<QuantLibraryClosed />);
  expect(html).toContain('Strategy library');
  expect(html).toContain('Saving to a library is off on this service, so the library is closed.');
  expect(html).not.toMatch(/<article|Use this strategy|Showing \d/);
});

it('no Quant room reads the shared library until per-account storage ships', () => {
  expect(readsSharedLibrary('studio')).toBe(false);
  expect(readsSharedLibrary('sandbox')).toBe(false);
  expect(readsSharedLibrary('backtest')).toBe(false);
});

it('Backtest has no shared library, asks for a Studio strategy and makes no list call', () => {
  query.mockClear();
  vi.stubGlobal('location', {
    pathname: '/quant/backtest',
    search: '',
    hash: '',
    origin: 'https://app.test',
    href: 'https://app.test/quant/backtest',
  });
  const html = renderToStaticMarkup(<Quant mode="backtest" />);
  vi.unstubAllGlobals();
  expect(html).toContain('Create a strategy in Studio first');
  expect(html).not.toContain('Use this strategy');
  expect(query.mock.calls.map((call) => (call as unknown[])[1])).not.toContain('studio.list');
});

it('Studio shows the closed library and makes no list, load or save call', () => {
  query.mockClear();
  mutate.mockClear();
  vi.stubGlobal('location', {
    pathname: '/quant/studio',
    search: '',
    hash: '',
    origin: 'https://app.test',
    href: 'https://app.test/quant/studio',
  });
  const html = renderToStaticMarkup(<Quant mode="studio" />);
  expect(html).toContain('so the library is closed');
  expect(html).not.toContain('Use this strategy');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Save to library<\/button>/);
  vi.unstubAllGlobals();
  const procedures = [...query.mock.calls, ...mutate.mock.calls].map((call) => (call as unknown[])[1]);
  expect(procedures).not.toContain('studio.list');
  expect(procedures).not.toContain('studio.save');
});
