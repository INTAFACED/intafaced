import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store; read the stored preferences once.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('./p2p-view', () => ({
  useP2PView: () => ({ api: {}, userId: 'a0000000-0000-4000-8000-000000000001', epoch: 0, current: () => true }),
}));
const pending = () => new Promise<never>(() => {});
vi.mock('./pay-api', async (original) => {
  const real = await original<typeof import('./pay-api')>();
  return {
    ...real,
    createPersonalPayApi: () =>
      new Proxy({ guard: { status: () => undefined, restore: () => Promise.resolve() } } as Record<string, unknown>, {
        get: (target, key: string) => (key in target ? target[key] : pending),
      }),
  };
});
import { P2P } from './P2P';

const render = (path: string) => {
  vi.stubGlobal('location', {
    pathname: path.split('?')[0],
    search: '',
    hash: '',
    origin: 'https://app.test',
    href: `https://app.test${path}`,
  });
  return renderToStaticMarkup(<P2P path={path} />);
};
/** The words of every link marked as the current page. */
const current = (html: string) =>
  [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>(.*?)<\/a>/g)].map((match) => match[1]!.replace(/<[^>]*>/g, ''));

describe('person-to-person rooms with nothing chosen', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('/chat with no order asks which order, links to Your orders, and marks one tab only', () => {
    const html = render('/chat');
    expect(html).toContain('Choose an order');
    expect(html).toMatch(/<a[^>]*href="\/uc\/order"[^>]*>Go to Your orders<\/a>/);
    expect(html).not.toContain('The request was refused');
    expect(html).not.toContain('Try again');
    expect(current(html)).toEqual(['Your orders']);
  });

  it('the Offers tab is the only one marked on the board', () => {
    expect(current(render('/p2p'))).toEqual(['Offers']);
  });

  it('/uc/ad/update with no offer is headed Edit offer, never Create an offer, and links to Your offers', () => {
    const html = render('/uc/ad/update');
    expect(html).toMatch(/<h1[^>]*>Edit offer<\/h1>/);
    expect(html).not.toContain('Create an offer');
    expect(html).toContain('Pick an offer to edit');
    expect(html).toMatch(/<a[^>]*href="\/uc\/ad"[^>]*>Go to Your offers<\/a>/);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('Service readiness');
  });

  it('/uc/ad/create keeps its own heading', () => {
    expect(render('/uc/ad/create')).toMatch(/<h1[^>]*>Create an offer<\/h1>/);
  });

  it('the counterparty room explains what it is for and where to go, instead of one line', () => {
    const html = render('/checkuser');
    expect(html).toContain('Choose a counterparty');
    expect(html).toContain('the other person in a trade');
    expect(html).toMatch(/<a[^>]*href="\/p2p"[^>]*>Browse offers<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/uc\/order"[^>]*>Go to Your orders<\/a>/);
  });

  it('the offer board no longer talks about windows, references or responses', () => {
    const html = render('/p2p');
    expect(html).toContain('Open a specific offer');
    expect(html).toContain('Refresh offers');
    expect(html).not.toMatch(/known offer reference|offer window|per response|complete history/i);
  });
});
