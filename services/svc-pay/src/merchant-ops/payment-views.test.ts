import { randomUUID } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { MerchantOpsError } from './errors.js';
import { maskCustomerEmail } from './invoices.js';
import { createPaymentViewsNamespaceRouter } from './payment-views-router.js';
import { definitionHash, maskRailRef, maskShopperName, parseViewBody, parseViewName, parseVisibility } from './payment-views.js';
import { canUnmaskPayments } from './roles.js';

const nid = () => randomUUID();
const principalOf = (userId: string): Principal => ({
  userId,
  sub: userId,
  sid: nid(),
  scopes: ['pay:read', 'pay:onboard', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
});
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: nid(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

const body = {
  filters: { status: 'captured' },
  sort: { field: 'createdAt', direction: 'desc' },
  columns: ['status', 'amount'],
};

describe('payment view definitions (M-adv-payments-core-01)', () => {
  it('masks a shopper email, name and rail reference and leaves a blank as null', () => {
    expect(maskCustomerEmail('buyer@example.com')).toBe('b***@e***.com');
    expect(maskCustomerEmail(null)).toBeNull();
    expect(maskShopperName('Ada Lovelace')).toBe('A***');
    expect(maskShopperName('  ')).toBeNull();
    expect(maskShopperName(null)).toBeNull();
    expect(maskRailRef('rail-secret-1234')).toBe('****1234');
    expect(maskRailRef('ab')).toBe('****');
    expect(maskRailRef(null)).toBeNull();
    expect(maskRailRef('rail-secret-1234')).not.toContain('secret');
  });

  it('refuses a blank name, an unknown visibility, a blank column list and a repeated column', () => {
    expect(() => parseViewName('   ')).toThrow(MerchantOpsError);
    expect(() => parseViewName('   ')).toThrow(/pay\.payment_view_name_blank/);
    expect(() => parseViewName('x'.repeat(81))).toThrow(/pay\.payment_view_name_invalid/);
    expect(() => parseVisibility('')).toThrow(/pay\.payment_view_visibility_invalid/);
    expect(() => parseViewBody({ ...body, columns: [] })).toThrow(/pay\.payment_view_columns_blank/);
    expect(() => parseViewBody({ ...body, columns: ['nope'] })).toThrow(/pay\.payment_view_column_unknown/);
    expect(() => parseViewBody({ ...body, columns: ['amount', 'amount'] })).toThrow(/pay\.payment_view_column_repeated/);
    expect(() => parseViewBody({ ...body, sort: { field: '', direction: 'desc' } })).toThrow(/pay\.payment_view_sort_unknown/);
  });

  it('refuses a blank amount filter and a window that ends before it starts, and does not treat a blank as zero', () => {
    expect(() => parseViewBody({ ...body, filters: { amountMin: '' } })).toThrow(/pay\.payment_view_filter_invalid/);
    expect(() => parseViewBody({ ...body, filters: { amountMin: 'nope' } })).toThrow(/pay\.payment_view_filter_invalid/);
    expect(() => parseViewBody({ ...body, filters: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' } })).toThrow(
      /pay\.payment_view_filter_invalid/,
    );
    const parsed = parseViewBody({ ...body, filters: { amountMin: '10', amountMax: '20.5' } });
    expect(parsed.filters.amountMin).toMatch(/^\d+(\.\d+)?$/);
    expect(parsed.filters.amountMax).toMatch(/^\d+(\.\d+)?$/);
    expect(JSON.stringify(parsed.filters)).not.toMatch(/:\s*\d+(\.\d+)?(?!")/);
  });

  it('hashes the definition, not a random id, and changes when the columns change', () => {
    const parsed = parseViewBody(body);
    expect(definitionHash(parsed)).toBe(definitionHash(parseViewBody(body)));
    expect(definitionHash(parsed)).toMatch(/^[0-9a-f]{64}$/);
    expect(definitionHash(parseViewBody({ ...body, columns: ['amount'] }))).not.toBe(definitionHash(parsed));
  });

  it('lets owner, admin and finance unmask, and not a viewer or a developer', () => {
    expect(canUnmaskPayments('owner')).toBe(true);
    expect(canUnmaskPayments('admin')).toBe(true);
    expect(canUnmaskPayments('finance')).toBe(true);
    expect(canUnmaskPayments('developer')).toBe(false);
    expect(canUnmaskPayments('viewer')).toBe(false);
  });

  it('refuses every procedure when the database is not connected', async () => {
    const api = createPaymentViewsNamespaceRouter({}).createCaller(ctxOf(principalOf(nid())));
    const error = await api.paymentViews.list({}).then(
      () => null,
      (caught: unknown) => caught as { code?: string; cause?: { code?: string } },
    );
    expect(error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(error?.cause?.code).toBe('pay.merchant_ops_unavailable');
  });
});
