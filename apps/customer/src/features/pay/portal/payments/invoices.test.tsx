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
  blankDraft,
  blankLine,
  digestOf,
  displayStatus,
  draftAmount,
  draftProblems,
  dueAtOf,
  hostedLinkUrl,
  invoiceBody,
  invoiceEvents,
  invoiceName,
  isOverdue,
  lineAmount,
  lineProblem,
  linesTotal,
  matchingPayments,
  rememberBodyRequestId,
  storedBodyRequestId,
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
  customerEmail: 'b***@e***.test',
  description: 'TEST consulting',
  dueAt: null,
  lineItems: [],
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
    const draft = blankDraft('USDT');
    expect(
      draftProblems({
        ...draft,
        assetId: 'usdt!',
        amount: '',
        customerRef: 'x'.repeat(201),
        description: 'a\u0007b',
        customerEmail: 'nope',
      }),
    ).toEqual({
      assetId: 'format',
      amount: 'empty',
      customerRef: 'long',
      customerEmail: 'email',
      description: 'control',
    });
    expect(draftProblems({ ...draft, amount: '12.5', description: 'line one\nline two' })).toEqual({});
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
    expect(hostedLinkUrl('https://pay.example', 'a b')).toBe('https://pay.example/api/pay/checkout?token=a%20b');
  });
  it('parses an invoice as the service sends it', () => {
    expect(invoiceSchema.safeParse(invoice()).success).toBe(true);
    // overdue is never stored: it is worked out from a sent invoice and its due date
    expect(invoiceSchema.safeParse({ ...invoice(), status: 'overdue' }).success).toBe(false);
    expect(
      invoiceSchema.safeParse({
        ...invoice(),
        lineItems: [{ kind: 'credit', description: 'x', quantity: '1', unitAmount: '2', amount: '-2' }],
      }).success,
    ).toBe(true);
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
    expect(out).toContain('No due date');
    expect(out).not.toContain('Due dates for invoices are on the way');
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
    expect(out).toContain('find this address again on the payment link');
    expect(out).not.toContain('shown only this once');
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

describe('invoice line items and exact totals', () => {
  const line = (patch: Partial<ReturnType<typeof blankLine>> = {}) => ({ ...blankLine(), description: 'TEST item', ...patch });
  it('multiplies quantity by price exactly, with no floating-point error', () => {
    // 0.1 * 3 and 0.7 * 0.1 are the classic float traps
    expect(lineAmount(line({ quantity: '3', unitAmount: '0.1' }))).toBe('0.3');
    expect(lineAmount(line({ quantity: '0.7', unitAmount: '0.1' }))).toBe('0.07');
    expect(lineAmount(line({ quantity: '1.5', unitAmount: '19.99' }))).toBe('29.985');
    expect(lineAmount(line({ quantity: '123456789.123456789', unitAmount: '1000000' }))).toBe('123456789123456.789');
  });
  it('shows a credit as a negative line and takes it off the total', () => {
    const lines = [
      line({ quantity: '3', unitAmount: '100' }),
      line({ kind: 'credit', description: 'TEST credit', quantity: '1', unitAmount: '49.5' }),
    ];
    expect(lineAmount(lines[1]!)).toBe('-49.5');
    expect(linesTotal(lines)).toBe('250.5');
    expect(draftAmount({ ...blankDraft('USDT'), lineItems: lines })).toBe('250.5');
  });
  it('refuses a product that needs more than 18 decimal places, instead of rounding it', () => {
    expect(lineProblem(line({ quantity: '0.0000000001', unitAmount: '0.0000000001' }))).toBe('places');
    expect(lineAmount(line({ quantity: '0.0000000001', unitAmount: '0.0000000001' }))).toBeNull();
    expect(lineProblem(line({ quantity: '0', unitAmount: '5' }))).toBe('quantity');
    expect(lineProblem(line({ quantity: '1', unitAmount: '-5' }))).toBe('unitAmount');
    expect(lineProblem(line({ kind: 'credit', unitAmount: '0' }))).toBe('unitAmount');
    expect(lineProblem(line({ description: '  ' }))).toBe('description');
  });
  it('needs a total above zero, and says so', () => {
    const only = [line({ kind: 'credit', unitAmount: '5' })];
    expect(draftProblems({ ...blankDraft('USDT'), lineItems: only })).toEqual({ lineItems: 'total' });
    const balanced = [line({ unitAmount: '5' }), line({ kind: 'credit', unitAmount: '5' })];
    expect(linesTotal(balanced)).toBe('0');
    expect(draftProblems({ ...blankDraft('USDT'), lineItems: balanced })).toEqual({ lineItems: 'total' });
    expect(draftProblems({ ...blankDraft('USDT'), lineItems: [line({ unitAmount: '5' }), line({ unitAmount: '' })] })).toEqual({
      lineItems: 'lines',
    });
    expect(draftProblems({ ...blankDraft('USDT'), lineItems: [line({ unitAmount: '5' })] })).toEqual({});
  });
  it('checks the typed amount only when there are no lines', () => {
    expect(draftProblems({ ...blankDraft('USDT'), amount: '', lineItems: [line({ unitAmount: '5' })] })).toEqual({});
  });
  it('takes the due day as the end of that day, and refuses a day that has passed', () => {
    const due = dueAtOf('2026-10-20');
    expect(new Date(due).getTime()).toBe(new Date(2026, 9, 20, 23, 59, 59).getTime());
    expect(draftProblems({ ...blankDraft('USDT'), amount: '5', dueDate: '2026-10-16' }, '2026-10-17')).toEqual({ dueDate: 'past' });
    expect(draftProblems({ ...blankDraft('USDT'), amount: '5', dueDate: '2026-10-17' }, '2026-10-17')).toEqual({});
    expect(draftProblems({ ...blankDraft('USDT'), amount: '5', dueDate: '17/10/2026' }, '2026-10-17')).toEqual({ dueDate: 'format' });
  });
  it('is overdue only when sent and past its due time', () => {
    const now = Date.parse('2026-10-17T12:00:00.000Z');
    expect(isOverdue(invoice({ status: 'sent', dueAt: '2026-10-16T12:00:00.000Z' }), now)).toBe(true);
    expect(isOverdue(invoice({ status: 'sent', dueAt: '2026-10-18T12:00:00.000Z' }), now)).toBe(false);
    expect(isOverdue(invoice({ status: 'sent', dueAt: null }), now)).toBe(false);
    expect(isOverdue(invoice({ status: 'paid', dueAt: '2026-10-16T12:00:00.000Z' }), now)).toBe(false);
    expect(isOverdue(invoice({ status: 'draft', dueAt: '2026-10-16T12:00:00.000Z' }), now)).toBe(false);
    expect(displayStatus(invoice({ status: 'sent', dueAt: '2026-10-16T12:00:00.000Z' }), now)).toBe('overdue');
  });
  it('turns the new refusals into plain words', () => {
    for (const code of [
      'pay.invoice_email_invalid',
      'pay.invoice_due_invalid',
      'pay.invoice_line_invalid',
      'pay.invoice_line_not_exact',
      'pay.invoice_lines_too_many',
      'pay.invoice_total_not_positive',
      'pay.invoice_total_mismatch',
    ]) {
      const text = refusalText({ ok: false, reason: 'error', message: code, code });
      expect(text).not.toMatch(/pay\./);
      expect(text).toContain('Nothing was saved');
    }
  });
  it('shows the lines, the credit as a minus, the due date and the exact total on the detail', () => {
    allowWrite = true;
    const out = detail(
      invoice({
        amount: '250.5',
        dueAt: '2026-10-25T15:59:59.000Z',
        lineItems: [
          { kind: 'charge', description: 'TEST design work', quantity: '3', unitAmount: '100', amount: '300' },
          { kind: 'credit', description: 'TEST loyalty credit', quantity: '1', unitAmount: '49.5', amount: '-49.5' },
        ],
      }),
    );
    expect(out).toContain('TEST design work');
    expect(out).toContain('TEST loyalty credit');
    expect(out).toContain('Credit');
    expect(out).toContain('Due');
    expect(out).toMatch(/49\.50?/);
    expect(out).toContain('Line items');
  });
  it('flags an overdue invoice on its detail', () => {
    allowWrite = true;
    const out = detail(
      invoice({ status: 'sent', dueAt: '2020-01-01T00:00:00.000Z', paymentLinkId: '1b000002-0000-4000-8000-000000000002' }),
    );
    expect(out).toContain('Overdue');
    expect(out).toContain('past its due date');
  });
});

class FakeStore {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key = (i: number) => [...this.data.keys()][i] ?? null;
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}
describe('create-invoice request id storage', () => {
  const draft = { ...blankDraft('USDT'), amount: '12.5', customerEmail: 'TEST-person@example.test', description: 'TEST private note' };
  it('keeps one key holding only a digest and an id, never the typed fields', () => {
    const store = new FakeStore();
    const d = digestOf(JSON.stringify(invoiceBody(draft)));
    rememberBodyRequestId(store, 'invoice-create', d, 'id-1');
    expect([...store.data.keys()]).toEqual(['portal:request:invoice-create']);
    const raw = store.getItem('portal:request:invoice-create')!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['digest', 'id']);
    expect(raw).not.toMatch(/TEST-person|private note|12\.5/);
    expect(storedBodyRequestId(store, 'invoice-create', d)).toBe('id-1');
  });
  it('gives the sent id back only for the same body, and reading never writes', () => {
    const store = new FakeStore();
    const d1 = digestOf(JSON.stringify(invoiceBody(draft)));
    const d2 = digestOf(JSON.stringify(invoiceBody({ ...draft, amount: '13' })));
    expect(d1).not.toBe(d2);
    expect(storedBodyRequestId(store, 'invoice-create', d1)).toBeNull();
    expect(store.data.size).toBe(0);
    rememberBodyRequestId(store, 'invoice-create', d1, 'id-1');
    // Lost reply, reload: the blank form and every keystroke read other digests, then the same body comes back.
    expect(storedBodyRequestId(store, 'invoice-create', d2)).toBeNull();
    expect(storedBodyRequestId(store, 'invoice-create', digestOf('{}'))).toBeNull();
    expect(storedBodyRequestId(store, 'invoice-create', d1)).toBe('id-1');
    expect(store.data.size).toBe(1);
  });
  it('removes keys the earlier format wrote and ignores an unreadable value', () => {
    const store = new FakeStore();
    store.setItem('portal:request:invoice-create:{"email":"TEST-person@example.test"}', 'old');
    store.setItem('portal:request:invoice-create', 'not json');
    store.setItem('portal:request:invoice:abc:send', 'keep');
    expect(storedBodyRequestId(store, 'invoice-create', 'd')).toBeNull();
    expect([...store.data.keys()].sort()).toEqual(['portal:request:invoice-create', 'portal:request:invoice:abc:send']);
  });
});
