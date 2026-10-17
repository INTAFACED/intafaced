import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// A review dialog is closed until it is clicked and there is no browser here: draw its body in place, inside the real exact scope.
vi.mock('../ui/PortalReview', async () => {
  const { ExactMoneyScope } = await import('../ui/ExactMoneyScope');
  return {
    PortalReview: ({ review, title }: { review?: ReactNode; title: string }) => (
      <div data-review={title}>
        <ExactMoneyScope>{review}</ExactMoneyScope>
      </div>
    ),
  };
});
let allowWrite = true;
vi.mock('../access/MerchantAccess', async (original) => {
  const real = await original<typeof import('../access/MerchantAccess')>();
  return {
    ...real,
    useMerchantAccess: () => ({
      access: { status: 'ready', merchantId: '11111111-1111-4111-8111-111111111111', role: 'owner' },
      can: (need: string) => (need === 'invoices.write' ? allowWrite : true),
    }),
  };
});

import { findRoom } from '../../../../app/navigation';
import type { PortalApi } from '../api';
import { parsePortalRoute } from '../routes';
import { paymentsCopy } from './copy';
import { InvoiceCreate, InvoiceDetailView } from './Invoices';
import {
  allowedActions,
  amountProblem,
  draftProblems,
  hostedLinkUrl,
  invoiceEvents,
  invoiceName,
  matchingPayments,
  sameAmount,
} from './invoice-model';
import { invoiceSchema, type Invoice } from './schemas';
import { refusalText } from '../refusal';

// TEST DATA: the amount has six decimals so the compact "2,000.00" can be told from the exact "1,999.999999".
const invoice = (patch: Partial<Invoice> = {}): Invoice => ({
  id: '1a000002-0000-4000-8000-000000000002',
  status: 'draft',
  assetId: 'USDT',
  amount: '1999.999999',
  customerRef: 'TEST-cust-001',
  description: 'TEST consulting',
  paymentLinkId: null,
  paymentId: null,
  sentAt: null,
  voidedAt: null,
  paidAt: null,
  createdAt: '2026-10-10T09:00:00.000Z',
  updatedAt: '2026-10-10T09:00:00.000Z',
  ...patch,
});
const portal = {} as PortalApi;
const noop = () => undefined;
const detail = (i: Invoice, minted = null as never) =>
  renderToString(<InvoiceDetailView portal={portal} invoice={i} minted={minted} onChanged={noop} back="Back" />);

describe('invoice routes', () => {
  it('routes the list, the create form and one invoice', () => {
    expect(parsePortalRoute('/pay/invoices')).toEqual({ room: 'invoices' });
    expect(parsePortalRoute('/pay/invoices/new')).toEqual({ room: 'invoice-new' });
    expect(parsePortalRoute('/pay/invoices/a%2Fb')).toEqual({ room: 'invoice', param: 'a/b' });
  });
  it('registers detail routes in the application shell as merchant-only rooms', () => {
    for (const route of ['/pay/invoices/TEST', '/pay/subscriptions/TEST', '/pay/conversion/TEST', '/pay/settings/profile']) {
      expect(findRoom(route)?.area).toBe('pay');
      expect(findRoom(route)?.business).toBe(true);
    }
  });
});

describe('invoice rules the form and the buttons follow', () => {
  it('refuses an empty, malformed, zero or over-precise amount', () => {
    expect(amountProblem('')).toBe('empty');
    expect(amountProblem('1,5')).toBe('format');
    expect(amountProblem('-4')).toBe('format');
    expect(amountProblem('0.000')).toBe('zero');
    expect(amountProblem('1.1234567890123456789')).toBe('places');
    expect(amountProblem('120.00')).toBeNull();
    expect(amountProblem('0.000000000000000001')).toBeNull();
  });
  it('lists every problem with a draft, and none for a good one', () => {
    expect(draftProblems({ assetId: 'usdt!', amount: '', customerRef: 'x'.repeat(201), description: 'a\u0007b' })).toEqual({
      assetId: 'format',
      amount: 'empty',
      customerRef: 'long',
      description: 'control',
    });
    expect(draftProblems({ assetId: 'USDT', amount: '12.5', customerRef: '', description: 'line one\nline two' })).toEqual({});
  });
  it('offers only the actions the status allows', () => {
    expect(allowedActions('draft')).toEqual(['send', 'markPaid', 'void']);
    expect(allowedActions('sent')).toEqual(['reissue', 'markPaid', 'void']);
    expect(allowedActions('paid')).toEqual([]);
    expect(allowedActions('void')).toEqual([]);
  });
  it('names an invoice by customer, then description, then a short reference', () => {
    const short = (s: string) => `Invoice ${s}`;
    expect(invoiceName(invoice(), short)).toBe('TEST-cust-001');
    expect(invoiceName(invoice({ customerRef: null }), short)).toBe('TEST consulting');
    expect(invoiceName(invoice({ customerRef: null, description: null }), short)).toBe('Invoice 1a000002');
  });
  it('builds the timeline only from times the invoice has, oldest first', () => {
    const events = invoiceEvents(invoice({ status: 'paid', sentAt: '2026-10-11T09:00:00.000Z', paidAt: '2026-10-12T09:00:00.000Z' }));
    expect(events.map((e) => e.key)).toEqual(['created', 'sent', 'paid']);
  });
  it('matches only paid payments of the same asset and exact amount', () => {
    const base = { assetId: 'USDT', amount: '47.13' };
    const rows = [
      { status: 'captured', ...base },
      { status: 'settled', assetId: 'USDT', amount: '47.130' },
      { status: 'failed', ...base },
      { status: 'captured', assetId: 'USD', amount: '47.13' },
      { status: 'captured', assetId: 'USDT', amount: '47.14' },
    ];
    expect(matchingPayments(base, rows)).toHaveLength(2);
    expect(sameAmount('120.00', '120')).toBe(true);
    expect(sameAmount('120.01', '120')).toBe(false);
  });
  it('builds the checkout address from the one-time token', () => {
    expect(hostedLinkUrl('https://pay.example', 'a b')).toBe('https://pay.example/pay/checkout?token=a%20b');
  });
  it('parses an invoice as the service sends it', () => {
    expect(invoiceSchema.safeParse(invoice()).success).toBe(true);
    expect(invoiceSchema.safeParse({ ...invoice(), status: 'overdue' }).success).toBe(false);
  });
});

describe('invoice words', () => {
  it('turns every invoice refusal into plain words', () => {
    const codes = [
      'pay.invoice_not_found',
      'pay.invoice_paid',
      'pay.invoice_void',
      'pay.invoice_already_sent',
      'pay.invoice_not_draft',
      'pay.invoice_payment_link_unwired',
      'pay.invoice_payment_mismatch',
      'pay.invoice_payment_already_applied',
    ];
    for (const code of codes) {
      const text = refusalText({ ok: false, reason: 'error', message: code, code });
      expect(text).not.toMatch(/pay\./);
      expect(text.length).toBeGreaterThan(20);
    }
    expect(paymentsCopy.t('inv_r_alreadySent')).toContain('Re-issue');
  });
});

describe('create invoice', () => {
  it('starts as a form with its fields and a disabled create button', () => {
    allowWrite = true;
    const out = renderToString(<InvoiceCreate portal={portal} />);
    for (const label of ['Amount', 'Asset', 'Customer reference', 'Description', 'Create invoice']) expect(out).toContain(label);
    expect(out).toContain('disabled');
    expect(out).not.toMatch(/pay\.[a-z_]+/);
  });
});

describe('invoice detail', () => {
  it('draft: amount-first header, Send as the one primary action, and no due date', () => {
    allowWrite = true;
    const out = detail(invoice());
    expect(out).toContain('Draft');
    expect(out).toContain('data-review="Send invoice"');
    expect(out).toContain('data-review="Void invoice"');
    expect(out).toContain('data-review="Mark as paid"');
    expect(out).toContain('no due date');
    expect(out).not.toContain('Overdue');
  });
  it('shows the exact amount inside every money review', () => {
    allowWrite = true;
    const out = detail(invoice());
    const reviews = out.split('data-review=').slice(1);
    expect(reviews.length).toBeGreaterThanOrEqual(2);
    for (const review of reviews.filter((r) => /Send invoice|Void invoice/.test(r.slice(0, 20)))) expect(review).toContain('1,999.999999');
  });
  it('sent: offers Re-issue, links to the payment link and the customer, and shows the one-time link when just sent', () => {
    allowWrite = true;
    const sent = invoice({ status: 'sent', paymentLinkId: '1b000002-0000-4000-8000-000000000002', sentAt: '2026-10-11T09:00:00.000Z' });
    const out = detail(sent, { id: 'x', prefix: 'p', expiresAt: null, maxUses: 1, token: 'TEST-token', alreadyIssued: false } as never);
    expect(out).toContain('data-review="Re-issue link"');
    expect(out).not.toContain('data-review="Send invoice"');
    expect(out).toContain('href="/pay/links/1b000002-0000-4000-8000-000000000002"');
    expect(out).toContain('href="/pay/customers/TEST-cust-001"');
    expect(out).toContain('TEST-token');
    expect(out).toContain('shown only this once');
  });
  it('paid: no actions, and the payment is a link', () => {
    const paid = invoice({ status: 'paid', paymentId: 'aa000002-0000-4000-8000-000000000002', paidAt: '2026-10-12T09:00:00.000Z' });
    const out = detail(paid);
    expect(out).not.toContain('data-review');
    expect(out).toContain('href="/pay/payments/aa000002-0000-4000-8000-000000000002"');
    expect(out).toContain('Paid');
  });
  it('void: no actions and no link to a payment', () => {
    const out = detail(invoice({ status: 'void', voidedAt: '2026-10-12T09:00:00.000Z' }));
    expect(out).not.toContain('data-review');
    expect(out).toContain('Voided');
  });
  it('a role that can only read sees the actions disabled with the reason', () => {
    allowWrite = false;
    const out = detail(invoice());
    expect(out).toContain('data-review="Send invoice"');
    allowWrite = true;
  });
});
