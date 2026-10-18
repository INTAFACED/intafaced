import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount, rewardPay } from '@intafaced/ledger-client';
import { miningPayoutIdempotencyKey, miningPayoutRewardId, postPayouts } from './ledger.js';

describe('mining postPayouts recipes', () => {
  it('refuses unset epoch and does not post', async () => {
    const ledger = new MemoryLedger();
    await expect(
      postPayouts(ledger, {
        windowId: 'w',
        assetId: 'IFC',
        reward: '10',
        feeBps: 100,
        shares: [{ shareId: 'a', minerId: '11111111-1111-4111-8111-111111111111', weight: 1n }],
      }),
    ).rejects.toThrow('mining.epoch_unset');
    expect(ledger.journal()).toHaveLength(0);
  });

  it('refuses unpublished emission and does not mint or rewardPay', async () => {
    const ledger = new MemoryLedger();
    await expect(
      postPayouts(ledger, {
        windowId: 'w',
        epoch: 1,
        assetId: 'IFC',
        reward: '10',
        feeBps: 100,
        shares: [{ shareId: 'a', minerId: '11111111-1111-4111-8111-111111111111', weight: 1n }],
      }),
    ).rejects.toThrow('mining.emission_unpublished');
    expect(ledger.journal()).toHaveLength(0);
  });

  it('refuses a JS number reward via parseAmount', async () => {
    const ledger = new MemoryLedger();
    await expect(
      postPayouts(ledger, {
        windowId: 'w',
        epoch: 1,
        assetId: 'IFC',
        reward: 10 as unknown as string,
        feeBps: 100,
        shares: [{ shareId: 'a', minerId: '11111111-1111-4111-8111-111111111111', weight: 1n }],
      }),
    ).rejects.toThrow(/decimal string/);
    expect(ledger.journal()).toHaveLength(0);
  });

  it('the payout read key is the rewardPay idempotency key', () => {
    const user = '11111111-1111-4111-8111-111111111111';
    const posted = rewardPay({
      rewardId: miningPayoutRewardId('w', user),
      userId: user,
      assetId: 'IFC',
      amount: parseAmount('1'),
      reason: 'mining.pplns.payout',
    });
    expect(miningPayoutIdempotencyKey('w', user)).toBe(posted.idempotencyKey);
    expect(posted.idempotencyKey).toBe('reward:mining:pplns:w:' + user);
  });
});
