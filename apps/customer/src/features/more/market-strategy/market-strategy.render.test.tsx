import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.stubGlobal('location', new URL('https://app.example.com/market/strategy'));

import { SessionProvider } from '../../session';
import { MarketStrategyRoom } from './MarketStrategyRoom';
import { readRefusal, retryable } from './read-refusal';

describe('/market/strategy on the flow template', () => {
  it('mounts under the page title and line the old page carried', () => {
    const html = renderToString(
      <SessionProvider>
        <MarketStrategyRoom />
      </SessionProvider>,
    );
    expect(html).toMatch(/<h1[^>]*>Strategy subscriptions<\/h1>/);
    expect(html).toContain('Published catalogue terms');
  });

  it('names a signed-out read with the sign-in link back to this room', () => {
    const refusal = readRefusal({ ok: false, reason: 'unauthorized', message: 'Session expired' }, 'en', '/market/strategy');
    expect(refusal).toMatchObject({ title: 'Sign in to continue', body: 'Session expired' });
    expect(refusal.action?.href).toBe('/login?redirect=%2Fmarket%2Fstrategy');
    expect(retryable({ ok: false, reason: 'unauthorized', message: '' })).toBe(false);
  });

  it('never shows a raw service code, and says plainly when the service is not connected', () => {
    const raw = readRefusal({ ok: false, reason: 'error', message: 'market.vendor_not_found', code: 'market.vendor_not_found' }, 'en', '/');
    expect(raw.body).not.toContain('market.vendor_not_found');
    const off = readRefusal({ ok: false, reason: 'error', message: 'x', code: 'edge.upstream_unwired' }, 'en', '/');
    expect(off).toMatchObject({ title: 'This service is not connected', body: 'This service isn’t connected here.' });
    expect(retryable({ ok: false, reason: 'unreachable', message: '' })).toBe(true);
  });
});
