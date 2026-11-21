import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { QUANT_SANDBOX_RUN } from '@intafaced/contracts/quant-sandbox-procedures';
import { QUANT_STUDIO_LIST } from '@intafaced/contracts/quant-studio-procedures';

const { query, mutate, call } = vi.hoisted(() => ({
  query: vi.fn(() => new Promise(() => undefined)),
  mutate: vi.fn(() => new Promise(() => undefined)),
  call: vi.fn((_record: { name: string }, _input: unknown) => new Promise(() => undefined)),
}));

// Server rendering has no browser store; read the stored preferences once.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// The room reads the signed-in session; give it a service that records every call.
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  const api = { query, mutate, call, canWrite: () => true };
  const session = { api, userId: 'a0000000-0000-4000-8000-000000000001', session: null };
  return { ...real, useSession: () => session as unknown as ReturnType<typeof real.useSession>, useApi: () => api as never };
});
import { Quant } from './Quant';

it('Backtest has no shared library, asks for a Studio strategy and makes no list call', () => {
  query.mockClear();
  call.mockClear();
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
  expect(query.mock.calls.map((made) => (made as unknown[])[1])).not.toContain('studio.list');
  // studio.list is called by its record: no call names it either.
  expect(call.mock.calls.map(([record]) => record.name)).not.toContain(QUANT_STUDIO_LIST.name);
});

it('Studio offers Save to library, sends nothing until the rules are complete, and reads the account library', () => {
  query.mockClear();
  mutate.mockClear();
  call.mockClear();
  vi.stubGlobal('location', {
    pathname: '/quant/studio',
    search: '',
    hash: '',
    origin: 'https://app.test',
    href: 'https://app.test/quant/studio',
  });
  const html = renderToStaticMarkup(<Quant mode="studio" />);
  vi.unstubAllGlobals();
  // Pressing Save on an incomplete form names what is blank and sends nothing (J-algo-dev-05 #4), so the button is not
  // greyed out; the service is still never called below.
  expect(html).toMatch(/<button[^>]*>Save to library<\/button>/);
  expect(html).toContain('Fill in a name, the starting cash, every block or signal rule input, and the three risk limits to save.');
  expect(html).toContain('Your strategy library');
  expect(html).not.toMatch(/Saving to a library is off/);
  expect(mutate).not.toHaveBeenCalled();
  expect(call.mock.calls.map(([record]) => record.name)).not.toContain(QUANT_SANDBOX_RUN.name);
});
