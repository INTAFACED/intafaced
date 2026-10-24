import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { LinksView, PaymentLinkForm, createLinkInputSchema, linkState } from './Links';
import type { BusinessPayApi } from '../../pay-api';
import { parsePortalRoute } from '../routes';
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
  // A catalogue price is named by its id; the service sets the amount and asset from it.
  expect(createLinkInputSchema.safeParse({ ...input, priceId: '33333333-3333-4333-8333-333333333333' }).success).toBe(true);
  expect(createLinkInputSchema.safeParse({ ...input, priceId: 'TEST price' }).success).toBe(false);
});
it('shows exact amounts and scoped loaded counts, with no placeholder card on a list that works', () => {
  const out = renderToString(<LinksView {...props} resource={{ status: 'ready', data: [link] }} />);
  expect(out).toContain('9,007,199,254,740,993.00');
  expect(out).toContain('1 shown from 1 link.');
  expect(out).toContain('1 of 3');
  expect(out).not.toMatch(/You’ll be able to/);
  expect(out).not.toContain('token=');
});
it('does not offer a real deactivate action without verified company authority', () => {
  const out = renderToString(<LinksView {...props} linkId={link.id} resource={{ status: 'ready', data: [link] }} />);
  expect(out).toMatch(/disabled=""[^>]*>Deactivate link/);
  expect(out).toContain('Only the account owner can create or turn off payment links.');
  // The address is shown only when the service sent it; until then the page says plainly that it can't be shown again.
  expect(out).toContain('Link address');
  expect(out).toContain('can’t be shown again');
  expect(out).not.toContain('can’t be filtered by payment link yet');
  expect(out).not.toContain('data-testid="link-address"');
  const withAddress = renderToString(
    <LinksView
      {...props}
      linkId={link.id}
      resource={{ status: 'ready', data: [{ ...link, checkoutUrl: 'https://checkout.test.invalid/pay/checkout?token=TEST-token' }] }}
    />,
  );
  expect(withAddress).toContain('data-testid="link-address"');
  expect(withAddress).toContain('https://checkout.test.invalid/pay/checkout?token=TEST-token');
  expect(withAddress).toContain('>Copy<');
  expect(withAddress).toContain('Open the link');
  expect(withAddress).toContain('QR code for the link address');
  expect(withAddress).not.toContain('can’t be shown again');
  const unsafe = renderToString(
    <LinksView
      {...props}
      linkId={link.id}
      resource={{ status: 'ready', data: [{ ...link, checkoutUrl: 'javascript:alert(1)' as never }] }}
    />,
  );
  // An address that is not http or https is never made clickable.
  expect(unsafe).not.toContain('javascript:');
  expect(unsafe).toContain('can’t be shown again');
});
it('shows Copy, Open and the QR code only while the link is active and not expired', () => {
  const url = 'https://checkout.test.invalid/pay/checkout?token=TEST-token';
  const show = (row: object) =>
    renderToString(<LinksView {...props} linkId={link.id} resource={{ status: 'ready', data: [{ ...link, checkoutUrl: url, ...row }] }} />);
  expect(show({})).toContain('data-testid="link-address"');
  for (const [row, words] of [
    [{ active: false }, 'This link is deactivated, so its address no longer takes payments.'],
    [{ expiresAt: '2020-01-01T00:00:00Z' }, 'This link can’t take another payment, so there is no address to share.'],
    [{ uses: 3 }, 'This link can’t take another payment, so there is no address to share.'],
  ] as const) {
    const out = show(row);
    expect(out).not.toContain('data-testid="link-address"');
    expect(out).not.toContain(url);
    expect(out).toContain(words);
    // a link that cannot take payments is not told to be shared
    expect(out).not.toContain('Share this address');
  }
  // No stored address at all: the same sentence.
  expect(renderToString(<LinksView {...props} linkId={link.id} resource={{ status: 'ready', data: [link] }} />)).toContain(
    'This link’s address can’t be shown again.',
  );
});
it('reads the payments made through a link once a payments reader is given', () => {
  const portal = {} as never;
  const out = renderToString(<LinksView {...props} portal={portal} linkId={link.id} resource={{ status: 'ready', data: [link] }} />);
  expect(out).toContain('Payments made with this link');
  expect(out).not.toContain('can’t be filtered by payment link yet');
});
it('offers the asset as a choice, not free text', () => {
  const out = renderToString(<PaymentLinkForm pay={pay} merchantId={link.id} />);
  expect(out).toMatch(/<select>(<option[^>]*>[^<]*<\/option>)+<\/select>/);
  expect(out).toContain('USDT');
  expect(out).not.toContain('Asset code');
});
it('renders grouped creation fields and keeps the review disabled without authority', () => {
  const out = renderToString(<PaymentLinkForm pay={pay} merchantId={link.id} />);
  expect(out).toContain('<legend>Checkout details</legend>');
  expect(out).toContain('<legend>Availability</legend>');
  expect(out).toMatch(/disabled=""[^>]*>Create link/);
});
it('routes creation and details without intercepting the legacy tool entry', () => {
  expect(parsePortalRoute('/pay/links/new')).toEqual({ room: 'link-new' });
  expect(parsePortalRoute(`/pay/links/${link.id}`)).toEqual({ room: 'link', param: link.id });
  expect(parsePortalRoute('/pay/links?view=tools')).toBeNull();
});

it('a deactivated link says so in its history and offers no deactivate button', () => {
  const out = renderToString(<LinksView {...props} linkId={link.id} resource={{ status: 'ready', data: [{ ...link, active: false }] }} />);
  expect(out).toContain('Deactivated');
  expect(out).toContain('Time not recorded');
  expect(out).not.toContain('Deactivate link');
});
