import type { ContractPart } from '../mock-contract-kit';

const merchant = '11111111-1111-4111-8111-111111111111';
export const paymentsContract: ContractPart = {
  cases: [
    { method: 'payments', run: (p) => p.payments(merchant, '', 25) },
    { method: 'payment', run: (p) => p.payment('aa000003-0000-4000-8000-000000000003') },
    { method: 'paymentHistory', run: (p) => p.paymentHistory('aa000003-0000-4000-8000-000000000003') },
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
    addEvidence: 'a write: the stand-in answers it, and the Playwright run exercises it',
    respond: 'a write: the stand-in answers it, and the Playwright run exercises it',
  },
};
