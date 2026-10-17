import type { ContractPart } from '../mock-contract-kit';

const settlement = 'bb000006-0000-4000-8000-000000000006';
export const moneyContract: ContractPart = {
  cases: [
    { method: 'settlements', run: (p) => p.settlements('11111111-1111-4111-8111-111111111111', '', 25) },
    { method: 'settlement', run: (p) => p.settlement(settlement) },
    { method: 'control', run: (p) => p.control('11111111-1111-4111-8111-111111111111') },
    { method: 'usage', run: (p) => p.usage('11111111-1111-4111-8111-111111111111') },
    {
      method: 'pricingPreview',
      run: (p) => p.pricingPreview({ merchantId: '11111111-1111-4111-8111-111111111111', assetCode: 'USDT', amount: '100' }),
    },
    { method: 'approvals', run: (p) => p.approvals('11111111-1111-4111-8111-111111111111', '') },
  ],
  notMocked: {
    decideApproval: 'a write: the stand-in answers it, and the Playwright run exercises it',
    cancelApproval: 'a write: the stand-in answers it, and the Playwright run exercises it',
  },
};
