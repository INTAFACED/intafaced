import { describe, expect, it } from 'vitest';
import { parseInactiveMessage, parseLinkConfirmation, paymentLinkEmbedSnippet } from './payment-link-share.js';

describe('payment link share', () => {
  it('refuses a blank confirmation and an http redirect, and keeps https', () => {
    expect(parseLinkConfirmation(undefined)).toEqual({ ok: true, message: null, url: null });
    expect(parseLinkConfirmation({ kind: 'message', message: '   ' })).toEqual({ ok: false, code: 'pay.link_confirmation_unset' });
    expect(parseLinkConfirmation({ kind: 'redirect', url: 'http://merchant.example/done' })).toEqual({
      ok: false,
      code: 'pay.link_redirect_not_https',
    });
    expect(parseLinkConfirmation({ kind: 'redirect', url: 'https://merchant.example/done' })).toEqual({
      ok: true,
      message: null,
      url: 'https://merchant.example/done',
    });
    expect(parseLinkConfirmation({ kind: 'redirect', url: 'HTTPS://merchant.example/done' })).toEqual({
      ok: true,
      message: null,
      url: 'https://merchant.example/done',
    });
    expect(parseLinkConfirmation({ kind: 'redirect', url: 'https:merchant.example/done' })).toEqual({
      ok: true,
      message: null,
      url: 'https://merchant.example/done',
    });
    expect(parseLinkConfirmation({ kind: 'message', message: ' Paid ' })).toEqual({ ok: true, message: 'Paid', url: null });
  });

  it('stores no invented deactivation message', () => {
    expect(parseInactiveMessage(undefined)).toEqual({ ok: true, message: null });
    expect(parseInactiveMessage('   ')).toEqual({ ok: true, message: null });
    expect(parseInactiveMessage('Closed for the day')).toEqual({ ok: true, message: 'Closed for the day' });
  });

  it('builds an embed snippet only for a fixed amount and does not invent a host', () => {
    expect(
      paymentLinkEmbedSnippet({ checkoutUrl: '/api/pay/checkout?token=pl_abc', amount: null, currency: 'USDT', label: 'Tip' }),
    ).toBeNull();
    expect(paymentLinkEmbedSnippet({ checkoutUrl: null, amount: '12.50', currency: 'USDT', label: 'Invoice' })).toBeNull();
    const snippet = paymentLinkEmbedSnippet({
      checkoutUrl: '/api/pay/checkout?token=pl_abc',
      amount: '12.50',
      currency: 'USDT',
      label: 'A & B',
    });
    expect(snippet).toBe('<a href="/api/pay/checkout?token=pl_abc" data-amount="12.50" data-asset="USDT">A &amp; B</a>');
    expect(snippet).not.toMatch(/^https?:/);
  });
});
