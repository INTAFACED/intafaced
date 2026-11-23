import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let stats: unknown;
vi.mock('../session', async (original) => ({
  ...(await original<typeof import('../session')>()),
  useSession: () => ({ userId: 'u-1', api: {} }),
}));
vi.mock('../../shared/resource', async (original) => ({
  ...(await original<typeof import('../../shared/resource')>()),
  useResource: () => ({ resource: stats, reload: () => undefined }),
}));

import { ShareSheet } from './ShareSheet';

describe('one-tap share: visits by surface', () => {
  it('with no invitation link yet, says why there are no counts instead of leaving the heading bare', () => {
    stats = { status: 'failed', failure: { ok: false, status: 404, code: 'share.not_found' } };
    const html = renderToString(<ShareSheet />);
    expect(html).toContain('Visits by surface');
    expect(html).toContain('data-testid="share-visits-none"');
    expect(html).toContain('No visits to count yet.');
    expect(html).not.toContain('role="alert"');
  });

  it('with a link, lists each surface’s count and no no-link line', () => {
    stats = { status: 'ready', data: { token: 't', surfaces: [{ surface: 'promotion', visits: 3 }] } };
    const html = renderToString(<ShareSheet />);
    expect(html).toContain('data-testid="share-visits-promotion"');
    expect(html).not.toContain('share-visits-none');
  });
});
