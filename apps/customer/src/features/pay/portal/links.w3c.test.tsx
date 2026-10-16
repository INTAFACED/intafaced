import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { LinksView, PaymentLinkForm, createLinkInputSchema, linkState } from './Links';
import type { BusinessPayApi } from '../pay-api';
import { parsePortalRoute } from './routes';
const pay = { access: () => ({ ok: false, reason: 'forbidden', message: 'TEST' }) } as unknown as BusinessPayApi;
const link = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'TEST workshop',
  prefix: 'TEST-prefix',
  amount: '9007199254740993.000000000000000001',
  currency: 'USDT',
  active: true,
  expiresAt: '2099-10-16T00:00:00Z',
  maxUses: 3,
  uses: 1,
  createdAt: '2026-10-16T00:00:00Z',
};
const props = { pay, merchantId: 'TEST', retry: () => {}, loadedAt: '2026-10-16T00:00:00Z', limit: 25, more: () => {} };
it('derives expiry, exhaustion and disabled status without treating an unreadable expiry as usable', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  expect(linkState(link, now)).toBe('active');
  expect(linkState({ ...link, active: false }, now)).toBe('inactive');
  expect(linkState({ ...link, expiresAt: '2026-10-15T00:00:00Z' }, now)).toBe('expired');
  expect(linkState({ ...link, uses: 3 }, now)).toBe('exhausted');
  expect(linkState({ ...link, expiresAt: null }, now)).toBe('unknown');
});
it('rejects invalid amounts and use caps; requires an asset for a fixed amount without inventing a default', () => {
  const input = { merchantId: link.id, label: 'TEST' };
  expect(createLinkInputSchema.safeParse(input).success).toBe(true);
  expect(createLinkInputSchema.safeParse({ ...input, amount: '1' }).success).toBe(false);
  expect(createLinkInputSchema.safeParse({ ...input, amount: '1', currency: 'USDT' }).success).toBe(true);
  expect(createLinkInputSchema.safeParse({ ...input, amount: '0', currency: 'USDT' }).success).toBe(false);
  expect(createLinkInputSchema.safeParse({ ...input, maxUses: 1.5 }).success).toBe(false);
  expect(createLinkInputSchema.safeParse({ ...input, maxUses: 1_000_001 }).success).toBe(false);
});
it('shows exact amounts, scoped loaded counts and the missing backend capabilities', () => {
  const out = renderToString(<LinksView {...props} resource={{ status: 'ready', data: [link] }} />);
  expect(out).toContain('9,007,199,254,740,993.00');
  expect(out).toContain('1 shown from 1 loaded links.');
  expect(out).toContain('search your links by date');
  expect(out).not.toContain('token=');
});
it('does not offer a real deactivate action without verified company authority', () => {
  const out = renderToString(<LinksView {...props} linkId={link.id} resource={{ status: 'ready', data: [link] }} />);
  expect(out).toMatch(/disabled=""[^>]*>Deactivate link/);
  expect(out).toContain('create and turn off payment links');
});
it('renders grouped creation fields and keeps the review disabled without authority', () => {
  const out = renderToString(<PaymentLinkForm pay={pay} merchantId={link.id} />);
  expect(out).toContain('<legend>Checkout details</legend>');
  expect(out).toContain('<legend>Availability</legend>');
  expect(out).toMatch(/disabled=""[^>]*>Review and create link/);
});
it('routes creation and details without intercepting the legacy tool entry', () => {
  expect(parsePortalRoute('/pay/links/new')).toEqual({ room: 'link-new' });
  expect(parsePortalRoute(`/pay/links/${link.id}`)).toEqual({ room: 'link', param: link.id });
  expect(parsePortalRoute('/pay/links?view=tools')).toBeNull();
});
