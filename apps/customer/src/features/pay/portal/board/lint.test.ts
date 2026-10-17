import { describe, expect, it } from 'vitest';
import { lintRenderedText } from './lint.mjs';

/** The crawler fails on these in a rendered page. Each check must be able to fail, or a green crawl proves nothing. */
describe('the rendered-text checks used by the board crawler', () => {
  const hits = (text: string, path = '/pay/x') => lintRenderedText(text, path);
  it.each([
    ['Type crypto_invoice', 'snake_case'],
    ['The service refused this request (503).', 'HTTP code'],
    ['Error 404 on load', 'HTTP code'],
    ['1 change(s) to your details', 'plural hedge'],
    ['You have 1 subscriptions', '1 subscriptions'],
    ['You have 3 payment', 'payments'],
    ['No ceiling returned', 'returned'],
    ['Reason\nactive\nNext', 'raw value'],
    ['Reason\nowner\nNext', 'raw value'],
    ['This creates a checkout capability', 'capability'],
    ['Fee: 150 basis points', 'basis points'],
    ['limit 200 outside this response', 'response'],
  ])('flags %j', (text, fragment) => {
    expect(hits(text).join(' | ')).toContain(fragment);
  });
  it.each(['1 payment', '3 payments', 'test_ab12', 'ifs_abc', '2 payment methods', 'Updated 12:00 UTC', '0 refunds', '30 days', 'Active'])(
    'lets %j through',
    (text) => {
      expect(hits(text)).toEqual([]);
    },
  );
  it('allows the word response where it is a business word, and webhook event names', () => {
    expect(hits('Dispute response due')).toEqual([]);
    expect(hits('Event: settlement.paid_out')).toEqual([]);
  });
});
