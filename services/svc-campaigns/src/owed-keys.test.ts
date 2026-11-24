import { describe, expect, it } from 'vitest';
import { parseAmount, recipes } from '@intafaced/ledger-client';
import { fundingDecisionOf, ledgerRewardId } from './payouts.js';

/**
 * The launch path's business keys (CI review on #8114): every reward key gives its own budget funding and its own Owe,
 * and each builds a recipe the ledger takes, for every key shape svc-campaigns writes.
 */
const CAMPAIGN = '3f1d2c4b-5a6e-4f70-8a91-b2c3d4e5f601';
const VOUCHER_A = '7a1d2c4b-5a6e-4f70-8a91-b2c3d4e5f6aa';
const VOUCHER_B = '7a1d2c4b-5a6e-4f70-8a91-b2c3d4e5f6bb';
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const KEYS = [
  `task:${CAMPAIGN}:${ACCOUNT}:once`,
  `task:${CAMPAIGN}:${ACCOUNT}:welcome:identity.verified`,
  `task:${CAMPAIGN}:${ACCOUNT}:earn:${encodeURIComponent('TEST rule')}:fill-1`,
  // An earning event keyed by a UUID, as a card authorisation's cashback is (J-bank-13 #7): too long to write whole.
  `task:${CAMPAIGN}:${ACCOUNT}:earn:${encodeURIComponent('Card cashback')}:d48b7f99-198e-425a-bd11-237af8c89b12`,
  `task:${CAMPAIGN}:${ACCOUNT}:earn:${encodeURIComponent('Card cashback')}:e48b7f99-198e-425a-bd11-237af8c89b12`,
  // The longest rule name an earning rule may have (80 characters).
  `task:${CAMPAIGN}:${ACCOUNT}:earn:${encodeURIComponent('R'.repeat(80))}:d48b7f99-198e-425a-bd11-237af8c89b12`,
  `voucher:${VOUCHER_A}:${ACCOUNT}:1`,
  `voucher:${VOUCHER_B}:${ACCOUNT}:1`,
  `voucher:${VOUCHER_A}:${ACCOUNT}:2`,
];

describe('owed reward keys', () => {
  it('give every reward its own budget funding and its own Owe: two vouchers in one campaign never share one', () => {
    expect(new Set(KEYS.map(fundingDecisionOf)).size).toBe(KEYS.length);
    expect(new Set(KEYS.map((k) => ledgerRewardId(CAMPAIGN, k))).size).toBe(KEYS.length);
  });

  it('build recipes the ledger takes for every key shape, each naming the reward’s own campaign', () => {
    for (const key of KEYS) {
      const fund = recipes.campaignBudgetFund({ campaignId: CAMPAIGN, decisionId: fundingDecisionOf(key), assetId: 'USDC', amount: 1n });
      const owe = recipes.rewardOwe({
        campaignId: CAMPAIGN,
        rewardId: ledgerRewardId(CAMPAIGN, key),
        userId: ACCOUNT,
        kind: 'reward',
        assetId: 'USDC',
        amount: parseAmount('0.01'),
        ceiling: { perCampaign: parseAmount('100'), total: parseAmount('1000') },
        owedSoFar: { campaign: 0n, total: 0n },
      });
      expect(fund.idempotencyKey.length, key).toBeLessThanOrEqual(200);
      expect(owe.idempotencyKey, key).toBe(`campaigns:owe:${ledgerRewardId(CAMPAIGN, key)}`);
    }
  });

  it('keep the keys of a reward that fits whole exactly as before, so a reward already owed books under its first keys', () => {
    const key = `task:${CAMPAIGN}:${ACCOUNT}:welcome:identity.verified`;
    expect(fundingDecisionOf(key)).toBe(`claim-task-${CAMPAIGN}-${ACCOUNT}-welcome-identity_verified`);
    expect(ledgerRewardId(CAMPAIGN, key)).toBe(`campaign:${CAMPAIGN}:task-${CAMPAIGN}-${ACCOUNT}-welcome-identity_verified`);
  });
});
