import type { ContractPart } from '../../mock-contract-kit';

const MERCHANT = '11111111-1111-4111-8111-111111111111';
const CHILD = 'c1000001-0000-4000-8000-000000000001';
const write = 'a write: the stand-in answers it, and the Playwright run exercises it';

/** The calls the account pages make, checked against the stand-in with the schemas they parse with in production. */
export const accountContract: ContractPart = {
  cases: [
    { method: 'profileGet', run: (p) => p.profileGet(MERCHANT) },
    { method: 'profileHistory', run: (p) => p.profileHistory(MERCHANT, undefined) },
    { method: 'onboardingProgress', run: (p) => p.onboardingProgress(MERCHANT) },
    { method: 'teamPage', run: (p) => p.teamPage(undefined, { role: 'finance', search: 'acc' }) },
    { method: 'activityList', run: (p) => p.activityList(undefined, { objectType: 'payment' }) },
    { method: 'subList', run: (p) => p.subList(MERCHANT) },
    { method: 'subGet', run: (p) => p.subGet(CHILD) },
    { method: 'subSummary', run: (p) => p.subSummary(CHILD) },
    { method: 'permAreas', run: (p) => p.permAreas() },
    { method: 'permGrants', run: (p) => p.permGrants(CHILD) },
    { method: 'permHistory', run: (p) => p.permHistory(CHILD) },
  ],
  notMocked: {
    profileSubmit: write,
    profileConfirm: write,
    profileSecondApproval: write,
    termsAccept: write,
    subCreate: write,
    permGrant: write,
    permRevoke: write,
  },
};
