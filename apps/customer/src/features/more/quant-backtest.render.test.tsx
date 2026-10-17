import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, mutate, draft } = vi.hoisted(() => ({
  query: vi.fn(() => new Promise(() => undefined)),
  mutate: vi.fn(() => new Promise(() => undefined)),
  draft: { current: null as null | { name: string; cash: string; blocks: unknown[]; drawdown: string; notional: string; kill: string } },
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
vi.mock('./quant-draft', async (original) => {
  const real = await original<typeof import('./quant-draft')>();
  return { ...real, readDraft: () => draft.current };
});
import { Quant } from './Quant';

const render = () => {
  vi.stubGlobal('location', {
    pathname: '/quant/backtest',
    search: '',
    hash: '',
    origin: 'https://app.test',
    href: 'https://app.test/quant/backtest',
  });
  const html = renderToStaticMarkup(<Quant mode="backtest" />);
  vi.unstubAllGlobals();
  return html;
};
const named = (name: string) => ({ name, cash: '', blocks: [], drawdown: '', notional: '', kill: '' });

describe('Quant Backtest form', () => {
  beforeEach(() => {
    draft.current = null;
  });

  it('never lets the customer choose a result: the field is a hypothesis and says it is not a result', () => {
    const html = render();
    expect(html).toContain('Your hypothesis');
    expect(html).toContain('not a result');
    expect(html).not.toContain('Evidence-based out-of-sample verdict');
    expect(html).not.toContain('Evidence verdict');
    expect(html).not.toContain('Declared verdict');
  });

  it('with no local draft it points to Studio instead of a free-text Strategy ID', () => {
    const html = render();
    expect(html).toContain('Create a strategy in Studio first');
    expect(html).toContain('href="/quant/studio"');
    expect(html).not.toContain('Strategy ID');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*?Review historical analysis/);
    expect(html).toContain('Choose a strategy draft');
  });

  it('with an unnamed draft it asks for a name', () => {
    draft.current = named('   ');
    expect(render()).toContain('Give your Studio draft a name first');
  });

  it('lists the named local draft in a picker', () => {
    draft.current = named('Momentum test');
    const html = render();
    expect(html).toContain('<option value="Momentum test">Momentum test</option>');
    expect(html).toContain('Choose a draft');
    expect(html).not.toContain('Create a strategy in Studio first');
  });

  it('shows plain-English cost models, never the raw model names or engineering words', () => {
    const html = render();
    for (const raw of [
      'venue-schedule',
      'order-book-replay',
      'measured-distribution',
      'tiered-venue-schedule',
      'measured-impact',
      'event-replay',
    ])
      expect(html).not.toContain(`>${raw}<`);
    expect(html).toContain('Venue’s published fee schedule');
    expect(html).toContain('Replay of the recorded order book');
    expect(html).toContain('Measured delay times');
    expect(html).not.toMatch(/data lake|performance producer|catalogue reference/i);
    expect(html).not.toContain('fees model');
  });
});
