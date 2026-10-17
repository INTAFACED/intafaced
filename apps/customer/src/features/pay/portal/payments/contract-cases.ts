import type { ContractPart } from '../mock-contract-kit';

const merchant = '11111111-1111-4111-8111-111111111111';
export const paymentsContract: ContractPart = {
  cases: [
    { method: 'payments', run: (p) => p.payments(merchant, '', 25) },
    { method: 'payment', run: (p) => p.payment('aa000003-0000-4000-8000-000000000003') },
    { method: 'paymentHistory', run: (p) => p.paymentHistory('aa000003-0000-4000-8000-000000000003') },
    { method: 'paymentPage', run: (p) => p.paymentPage(merchant, { assetId: 'USDT' }, undefined) },
    { method: 'paymentRefundRows', run: (p) => p.paymentRefundRows('aa000004-0000-4000-8000-000000000004', merchant) },
    { method: 'paymentActivity', run: (p) => p.paymentActivity('aa000003-0000-4000-8000-000000000003') },
    { method: 'invoices', run: (p) => p.invoices({ status: 'sent' }, undefined) },
    { method: 'invoice', run: (p) => p.invoice('1a000002-0000-4000-8000-000000000002') },
    {
      method: 'createInvoice',
      run: (p) =>
        p.createInvoice({
          requestId: '5e000001-0000-4000-8000-000000000001',
          assetId: 'USDT',
          amount: '12.345678',
          customerRef: 'TEST-cust-001',
        }),
    },
    {
      method: 'sendInvoice',
      run: (p) => p.sendInvoice({ requestId: '5e000002-0000-4000-8000-000000000002', invoiceId: '1a000001-0000-4000-8000-000000000001' }),
    },
    {
      method: 'voidInvoice',
      run: (p) => p.voidInvoice({ requestId: '5e000003-0000-4000-8000-000000000003', invoiceId: '1a000002-0000-4000-8000-000000000002' }),
    },
    { method: 'disputeSummary', run: (p) => p.disputeSummary() },
    { method: 'disputes', run: (p) => p.disputes(undefined, '') },
    { method: 'dispute', run: (p) => p.dispute('d0000001-0000-4000-8000-000000000001') },
    { method: 'customerSummary', run: (p) => p.customerSummary('2026-09-01T00:00:00.000Z') },
    { method: 'customers', run: (p) => p.customers(undefined, '') },
    { method: 'customer', run: (p) => p.customer('TEST-cust-001') },
  ],
  notMocked: {
    subscriptions: 'Package 2 adds subscription fixtures',
    subscription: 'Package 2 adds subscription fixtures',
    mandates: 'Package 2 adds mandate fixtures',
    mandate: 'Package 2 adds mandate fixtures',
    subscriptionPosture: 'Package 2 adds subscription fixtures',
    subscriptionExecutions: 'Package 2 adds subscription fixtures',
    subscriptionCycles: 'Package 2 adds subscription fixtures',
    links: 'Package 2 adds link fixtures',
    reissueInvoiceLink: 'a write: the stand-in answers it, and the unit tests exercise it',
    markInvoicePaid: 'a write: the stand-in answers it, and the unit tests exercise it',
    addEvidence: 'a write: the stand-in answers it, and the Playwright run exercises it',
    respond: 'a write: the stand-in answers it, and the Playwright run exercises it',
  },
};
