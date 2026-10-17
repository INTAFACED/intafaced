import type { ContractPart } from '../mock-contract-kit';

const merchant = '11111111-1111-4111-8111-111111111111';
export const paymentsContract: ContractPart = {
  cases: [
    { method: 'payments', run: (p) => p.payments(merchant, '', 25) },
    { method: 'payment', run: (p) => p.payment('aa000003-0000-4000-8000-000000000003') },
    { method: 'paymentHistory', run: (p) => p.paymentHistory('aa000003-0000-4000-8000-000000000003') },
    { method: 'links', run: (p) => p.links(merchant, 25) },
    { method: 'subscriptions', run: (p) => p.subscriptions(merchant, 25) },
    { method: 'subscriptionPage', run: (p) => p.subscriptionPage(merchant, { status: 'active' }, undefined) },
    { method: 'subscription', run: (p) => p.subscription(merchant, '1e000001-0000-4000-8000-000000000001') },
    { method: 'mandates', run: (p) => p.mandates(merchant) },
    { method: 'mandate', run: (p) => p.mandate(merchant, '1d000001-0000-4000-8000-000000000001') },
    { method: 'subscriptionPosture', run: (p) => p.subscriptionPosture() },
    { method: 'subscriptionExecutions', run: (p) => p.subscriptionExecutions('1e000001-0000-4000-8000-000000000001') },
    { method: 'subscriptionCycles', run: (p) => p.subscriptionCycles('1e000001-0000-4000-8000-000000000001') },
    { method: 'disputePage', run: (p) => p.disputePage({ status: 'open' }, undefined) },
    { method: 'ownTier', run: (p) => p.ownTier(merchant) },
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
    { method: 'customerSeries', run: (p) => p.customerSeries('TEST-cust-001', '2026-09-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z') },
    { method: 'customer', run: (p) => p.customer('TEST-cust-001') },
  ],
  notMocked: {
    reissueInvoiceLink: 'a write: the stand-in answers it, and the unit tests exercise it',
    markInvoicePaid: 'a write: the stand-in answers it, and the unit tests exercise it',
    uploadEvidence: 'a write: the stand-in answers it, and the unit tests exercise it',
    evidenceFile: 'bytes, not a shape: the unit tests exercise it',
    addEvidence: 'a write: the stand-in answers it, and the Playwright run exercises it',
    respond: 'a write: the stand-in answers it, and the Playwright run exercises it',
  },
};
