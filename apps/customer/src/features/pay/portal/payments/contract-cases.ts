import type { ContractPart } from '../mock-contract-kit';

const merchant = '11111111-1111-4111-8111-111111111111';
export const paymentsContract: ContractPart = {
  cases: [
    { method: 'payments', run: (p) => p.payments(merchant, '', 25) },
    { method: 'payment', run: (p) => p.payment('aa000003-0000-4000-8000-000000000003') },
    { method: 'paymentHistory', run: (p) => p.paymentHistory('aa000003-0000-4000-8000-000000000003') },
    { method: 'links', run: (p) => p.links(merchant, 25) },
    { method: 'checkoutSettings', run: (p) => p.checkoutSettings(merchant) },
    { method: 'checkoutLook', run: (p) => p.checkoutLook() },
    {
      method: 'saveCheckoutLook',
      run: (p) => p.saveCheckoutLook({ requestId: 'c3000001-0000-4000-8000-0000000000aa', expectedVersion: 0, brandColor: '#FF6600' }),
    },
    { method: 'checkoutMethods', run: (p) => p.checkoutMethods() },
    {
      method: 'saveCheckoutMethods',
      run: (p) =>
        p.saveCheckoutMethods({
          requestId: 'c3000001-0000-4000-8000-0000000000ab',
          expectedVersion: 0,
          methods: (['bank_debit', 'crypto', 'card', 'pay_later', 'bank_transfer'] as const).map((method) => ({
            method,
            enabled: method !== 'pay_later',
            ruleAsset: null,
            minAmount: null,
            maxAmount: null,
          })),
        }),
    },
    { method: 'previewCheckoutMethods', run: (p) => p.previewCheckoutMethods({ country: 'DE', currency: 'EUR' }) },
    { method: 'paymentPage', run: (p) => p.paymentPage(merchant, { linkId: '1c000001-0000-4000-8000-000000000001' }, undefined) },
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
    {
      method: 'refundsIssued',
      run: (p) => p.refundsIssued(merchant, { from: '2026-09-18T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z' }),
    },
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
      method: 'createInvoice',
      run: (p) =>
        p.createInvoice({
          requestId: '5e000004-0000-4000-8000-000000000004',
          assetId: 'USDT',
          amount: '250.5',
          customerEmail: 'buyer@example.test',
          dueAt: '2026-11-01T15:59:59.000Z',
          lineItems: [
            { kind: 'charge', description: 'TEST work', quantity: '3', unitAmount: '100' },
            { kind: 'credit', description: 'TEST credit', quantity: '1', unitAmount: '49.5' },
          ],
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
    { method: 'paymentViews', run: (p) => p.paymentViews() },
    {
      method: 'createPaymentView',
      run: (p) =>
        p.createPaymentView({ name: 'TEST captured', visibility: 'private', filters: { status: 'captured' }, columns: ['amount'] }),
    },
    {
      method: 'unmaskPayment',
      run: (p) => p.unmaskPayment({ paymentId: 'aa000003-0000-4000-8000-000000000003', field: 'customerEmail', reason: 'TEST reason' }),
    },
  ],
  notMocked: {
    deletePaymentView: 'a write: the stand-in answers it, and the unit tests exercise it',
    reissueInvoiceLink: 'a write: the stand-in answers it, and the unit tests exercise it',
    markInvoicePaid: 'a write: the stand-in answers it, and the unit tests exercise it',
    uploadEvidence: 'a write: the stand-in answers it, and the unit tests exercise it',
    evidenceFile: 'bytes, not a shape: the unit tests exercise it',
    addEvidence: 'a write: the stand-in answers it, and the Playwright run exercises it',
    respond: 'a write: the stand-in answers it, and the Playwright run exercises it',
  },
};
