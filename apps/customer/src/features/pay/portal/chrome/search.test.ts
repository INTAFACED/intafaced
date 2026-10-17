import { describe, expect, it } from 'vitest';
import { pageMatches, paymentTarget } from './search';

const pages = [
  { href: '/pay/payments', label: 'Payments', group: 'Payments' },
  { href: '/pay/refunds', label: 'Refunds', group: 'Payments' },
  { href: '/pay/payouts', label: 'Payouts', group: 'Money' },
];
describe('portal search', () => {
  it('lists every page for an empty search', () => {
    expect(pageMatches(pages, '')).toHaveLength(3);
  });
  it('matches the page name or its tab, every word', () => {
    expect(pageMatches(pages, 'ref').map((p) => p.href)).toEqual(['/pay/refunds']);
    expect(pageMatches(pages, 'money pay').map((p) => p.href)).toEqual(['/pay/payouts']);
    expect(pageMatches(pages, 'nothing here')).toEqual([]);
  });
  it('sends a pasted payment ID straight to that payment, and nothing else', () => {
    expect(paymentTarget(' aa000003-0000-4000-8000-000000000003 ')).toBe('/pay/payments/aa000003-0000-4000-8000-000000000003');
    expect(paymentTarget('aa000003')).toBeNull();
    expect(paymentTarget('../../etc')).toBeNull();
  });
});
