import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
// Server rendering has no external store snapshot for the language preference; read it directly.
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// `null` is "no business frame"; otherwise whether the person holds `payments.unmask`.
let unmask: boolean | null = null;
vi.mock('../access/MerchantAccess', async (original) => {
  const real = await original<typeof import('../access/MerchantAccess')>();
  return {
    ...real,
    useOptionalMerchantAccess: () => (unmask === null ? null : { can: (need: string) => (need === 'payments.unmask' ? unmask : true) }),
  };
});
import type { PortalApi } from '../api';
import type { ListFilters } from '../ui/FilterRow';
import type * as p from '../schemas';
import { parseColumns, PayerEmailCell, viewFiltersOf } from './PaymentViews';

// TEST DATA written for these tests. None of it is a real payer, payment or amount.
const portal = {} as PortalApi;
const payment = (customerEmail: string | null) => ({ id: 'aa000001-0000-4000-8000-000000000001', customerEmail }) as unknown as p.Payment;
const filters = (patch: Partial<ListFilters>) =>
  ({ search: '', status: '', date: '', from: '', to: '', asset: '', ...patch }) as unknown as ListFilters;

describe('saved payment views and the payer email (M-adv-payments-core-01)', () => {
  it('reads columns from the address in list order, drops unknown names and falls back to the default set', () => {
    expect(parseColumns('customerEmail,amount,bogus,amount')).toEqual(['amount', 'customerEmail']);
    expect(parseColumns('')).toEqual(['payment', 'amount', 'status', 'method', 'created']);
    expect(parseColumns('nothing,known')).toEqual(['payment', 'amount', 'status', 'method', 'created']);
  });

  it('keeps the list filters a view can hold, and never a custom date range', () => {
    expect(viewFiltersOf(filters({ status: 'captured', search: '  TEST-cust-ada ', asset: 'USDT', date: '7d' } as never))).toEqual({
      status: 'captured',
      search: 'TEST-cust-ada',
      assetId: 'USDT',
      date: '7d',
    });
    expect(viewFiltersOf(filters({ date: 'custom', from: '2026-10-01' } as never))).toEqual({});
    expect(viewFiltersOf(filters({ status: 'nonsense' }))).toEqual({});
  });

  it('shows the masked email with Unmask only to a role holding payments.unmask', () => {
    unmask = true;
    const finance = renderToString(<PayerEmailCell portal={portal} payment={payment('a***@e***.test')} />);
    expect(finance).toContain('a***@e***.test');
    expect(finance).toContain('>Unmask<');
    unmask = false;
    const viewer = renderToString(<PayerEmailCell portal={portal} payment={payment('a***@e***.test')} />);
    expect(viewer).toContain('a***@e***.test');
    expect(viewer).not.toContain('Unmask');
    unmask = null;
    expect(renderToString(<PayerEmailCell portal={portal} payment={payment('a***@e***.test')} />)).not.toContain('Unmask');
  });

  it('says so when a payment carries no payer email, and offers nothing to unmask', () => {
    unmask = true;
    const out = renderToString(<PayerEmailCell portal={portal} payment={payment(null)} />);
    expect(out).toContain('No email');
    expect(out).not.toContain('Unmask');
  });
});
