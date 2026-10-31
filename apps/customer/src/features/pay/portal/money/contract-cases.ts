import type { ContractPart } from '../mock-contract-kit';

const M = '11111111-1111-4111-8111-111111111111';
const settlement = 'bb000006-0000-4000-8000-000000000006';
const paid = 'bb000002-0000-4000-8000-000000000002';
const day = 86_400_000;
const range = { from: new Date(Date.now() - 30 * day).toISOString(), to: new Date(Date.now() + day).toISOString() };

export const moneyContract: ContractPart = {
  cases: [
    { method: 'settlements', run: (p) => p.settlements(M, '', 25) },
    { method: 'settlement', run: (p) => p.settlement(settlement) },
    { method: 'settlementPage', run: (p) => p.settlementPage(M, { status: 'posted' }, undefined) },
    { method: 'settlementLines', run: (p) => p.settlementLines(settlement, undefined) },
    { method: 'settlementLifecycle', run: (p) => p.settlementLifecycle(paid) },
    { method: 'clearing', run: (p) => p.clearing(M) },
    { method: 'payoutPage', run: (p) => p.payoutPage({}, undefined) },
    { method: 'statementPage', run: (p) => p.statementPage(M, { assetId: 'USDT', ...range }, undefined) },
    { method: 'refundPage', run: (p) => p.refundPage(M, {}, undefined) },
    { method: 'refundGet', run: (p) => p.refundGet('cc100001-0000-4000-8000-000000000101') },
    { method: 'destinationPage', run: (p) => p.destinationPage(M, undefined) },
    { method: 'feeRates', run: (p) => p.feeRates({ merchantId: M, ...range }) },
    { method: 'approvalPage', run: (p) => p.approvalPage(M, { status: 'pending' }, undefined) },
    { method: 'refundablePayments', run: (p) => p.refundablePayments(M, '') },
    { method: 'control', run: (p) => p.control(M) },
    { method: 'reserve', run: (p) => p.reserve(M) },
    { method: 'usage', run: (p) => p.usage(M) },
    { method: 'pricingPreview', run: (p) => p.pricingPreview({ merchantId: M, assetCode: 'USDT', amount: '100' }) },
    { method: 'approvals', run: (p) => p.approvals(M, '') },
    { method: 'limitOpen', run: (p) => p.limitOpen(M) },
    { method: 'tiersList', run: (p) => p.tiersList(M) },
    { method: 'pricingHistory', run: (p) => p.pricingHistory(M) },
    { method: 'conversionList', run: (p) => p.conversionList(M) },
    { method: 'conversionGet', run: (p) => p.conversionGet('ee100001-0000-4000-8000-000000000001') },
  ],
  notMocked: {
    destinationAdd: 'a write: the stand-in answers it, and the Playwright run exercises it',
    destinationSetDefault: 'a write: the stand-in answers it, and the Playwright run exercises it',
    destinationRemove: 'a write: the stand-in answers it, and the Playwright run exercises it',
    decideApproval: 'a write: the stand-in answers it, and the Playwright run exercises it',
    cancelApproval: 'a write: the stand-in answers it, and the Playwright run exercises it',
    requestPayoutApproval: 'a write: the stand-in answers it, and the Playwright run exercises it',
    sendPayout: 'a write: the stand-in answers it, and the Playwright run exercises it',
    limitRequestIncrease: 'a write: the stand-in answers it, and the Playwright run exercises it',
    limitWithdraw: 'a write: the stand-in answers it, and the Playwright run exercises it',
    conversionQuote: 'a write: the stand-in answers it, and the Playwright run exercises it',
    conversionExecute: 'a write: the stand-in answers it, and the Playwright run exercises it',
    moneyExportCreate: 'a write: the Settings stand-in answers it and the Playwright run exercises it',
    topUpOptions:
      'the stand-in answers it only with its refusal (412 pay.topup_unconfigured) and a case here must parse an ok answer, which does not exist until a top-up rail does; the real code is held by svc-pay top-up.db.test.ts and J-merchant-07 #5',
  },
};
