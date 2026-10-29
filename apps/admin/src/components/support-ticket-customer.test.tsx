import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CustomerCardView } from '@/lib/support/types';
import { TicketCustomerView } from './support-ticket-customer';

const U = '11111111-1111-4111-8111-111111111111';
const html = (card: CustomerCardView | null, loading = false) =>
  renderToStaticMarkup(<TicketCustomerView userId={U} card={card} loading={loading} />);
const state = (out: string) => /data-testid="customer-account-state">([^<]*)</.exec(out)?.[1];

describe('customer card', () => {
  it('shows the state identity gave, with its tier and when it was read', () => {
    const out = html({
      asOf: '2026-10-29T12:00:00.000Z',
      account: {
        kind: 'ok',
        data: { status: 'read', state: { userId: U, status: 'frozen', kycTier: 'basic' }, readAt: '2026-10-29T12:00:00.000Z' },
      },
    });
    expect(state(out)).toBe('frozen');
    expect(out).toContain('KYC tier basic');
  });
  it('says "unread", never "active", when identity could not be reached', () => {
    const out = html({ asOf: 'x', account: { kind: 'ok', data: { status: 'unread', reason: 'plane_dark' } } });
    expect(state(out)).toBe('unread');
    expect(out).toContain('could not reach the identity service');
    expect(out).not.toContain('>active<');
  });
  it('says "unread" when svc-support refused or did not answer the read', () => {
    const refused = html({
      asOf: 'x',
      account: { kind: 'failed', message: 'not allowed', code: 'support.forbidden', notBuilt: false, forbidden: true },
    });
    expect(state(refused)).toBe('unread');
    expect(refused).toContain('Account state unavailable');
    expect(state(html(null))).toBe('unread');
  });
  it('shows no state while reading, and the related order is "none"', () => {
    const out = html(null, true);
    expect(state(out)).toBeUndefined();
    expect(out).toContain('Reading…');
    expect(out).toContain('data-testid="customer-related-order">none<');
  });
});
