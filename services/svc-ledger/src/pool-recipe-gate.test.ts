import { parseAmount, recipes, type PostRequest } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { LEDGER_CALLER_SERVICES, grantFor } from './caller-allowlist.js';
import { assertKnownRecipePost, recipeCandidates } from './recipe-gate.js';

/** LG-pool-recipes-01: the gate knows the pool shapes; no caller is granted them until svc-trade callers exist. */
const U = '11111111-1111-4111-8111-111111111111';
const AMT = parseAmount('5');
const POOL = ['poolSubscribe', 'poolRedeem', 'poolProfit', 'poolRaise'] as const;

const wire = (p: PostRequest) => ({
  module: p.module,
  reason: p.reason,
  entries: p.entries.map((e) => ({ account: e.account, direction: e.direction })),
});

describe('svc-ledger gate: pool recipes', () => {
  it('accepts every pool shape as its own recipe, with real ids', () => {
    const cases: Array<[string, PostRequest]> = [
      ['poolSubscribe', recipes.poolSubscribe({ poolId: 'pool-9', userId: U, assetId: 'USDC', amount: AMT, subscriptionId: 's9' })],
      ['poolRedeem', recipes.poolRedeem({ poolId: 'pool-9', userId: U, assetId: 'USDC', amount: AMT, redemptionId: 'r9', leg: 'request' })],
      ['poolRedeem', recipes.poolRedeem({ poolId: 'pool-9', userId: U, assetId: 'USDC', amount: AMT, redemptionId: 'r9', leg: 'pay' })],
      ['poolProfit', recipes.poolProfit({ poolId: 'pool-9', assetId: 'USDC', amount: AMT, direction: 'gain', periodId: 'q9' })],
      ['poolProfit', recipes.poolProfit({ poolId: 'pool-9', assetId: 'USDC', amount: AMT, direction: 'loss', periodId: 'q9' })],
      ['poolRaise', recipes.poolRaise({ poolId: 'pool-9', masterUserId: U, assetId: 'USDC', amount: AMT, raiseId: 'z9' })],
    ];
    for (const [name, post] of cases) {
      expect(() => assertKnownRecipePost(wire(post))).not.toThrow();
      expect(recipeCandidates(wire(post))).toContain(name);
    }
  });

  it('refuses a pool reason whose profit leg was swapped to a house fee account', () => {
    const post = recipes.poolProfit({ poolId: 'pool-9', assetId: 'USDC', amount: AMT, direction: 'gain', periodId: 'q9' });
    const forged = wire(post);
    forged.entries[0] = { account: { ownerType: 'house', ownerId: 'fees:trade', assetId: 'USDC', kind: 'available' }, direction: 'credit' };
    expect(() => assertKnownRecipePost(forged)).toThrow(/not a known recipe/);
  });

  it('grants no service any pool recipe (callers land with CB-copy-pro-share-04/07/08/09)', () => {
    for (const service of LEDGER_CALLER_SERVICES) {
      for (const name of POOL) expect(grantFor(service, name), `${service}/${name}`).toBeUndefined();
    }
  });
});
