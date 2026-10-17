import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { ConversionView } from './Conversion';
import { parsePortalRoute } from '../routes';
import { notLiveWords } from '../ui/test-words';
const props = { halts: { status: 'ready' as const, data: { states: [], readable: true } }, reload: () => {} };
it('routes conversion hub, quote and order independently', () => {
  expect(parsePortalRoute('/pay/conversion')).toEqual({ room: 'conversion' });
  expect(parsePortalRoute('/pay/conversion/new')).toEqual({ room: 'conversion-new' });
  expect(parsePortalRoute('/pay/conversion/order')).toEqual({ room: 'conversion-order', param: 'order' });
});
it('labels all routes TEST and never fabricates a rate or quote confirmation', () => {
  for (const room of ['conversion', 'conversion-new', 'conversion-order']) {
    const out = renderToString(<ConversionView {...props} room={room} orderId="TEST-order" />);
    expect(out).toContain('TEST · Sandbox / testnet only');
    expect(out).toMatch(notLiveWords);
    expect(out).not.toMatch(/1\.00|0\.00|>Confirm/);
  }
});
it('keeps quote requests disabled even if the halt read is clear', () => {
  const out = renderToString(<ConversionView {...props} room="conversion-new" />);
  expect(out).toMatch(/<button[^>]*disabled[^>]*>Get quote/);
  expect(out).toContain('review the exchange rate and fees');
});
it('does not leak the existence of an unreadable conversion order', () => {
  expect(renderToString(<ConversionView {...props} room="conversion-order" orderId="TEST-foreign" />)).toContain(
    'does not confirm whether the reference exists',
  );
});

it('shows unavailable source and target assets until quote configuration exists', () => {
  const out = renderToString(<ConversionView {...props} room="conversion-new" />);
  expect(out).toMatch(/Source asset<\/dt><dd[^>]*>Not available yet<\/dd>/);
  expect(out).toMatch(/Target asset<\/dt><dd[^>]*>Not available yet<\/dd>/);
  expect(out).not.toMatch(/<dd[^>]*>(USD|USDT)<\/dd>/);
});
