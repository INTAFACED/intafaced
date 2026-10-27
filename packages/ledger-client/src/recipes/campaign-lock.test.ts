import { describe, expect, it } from 'vitest';
import { rewardsEngine, userAvailable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InsufficientFundsError, InvalidEntryError } from '../types.js';
import { CAMPAIGN_REWARD_KEY_MAX, campaignLockAccount } from './campaign-lock.js';
import { recipes } from './index.js';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const PAYER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';
const KEY = 'task:33333333-3333-4333-8333-333333333333:11111111-1111-4111-8111-111111111111:once';
const OTHER_KEY = 'task:44444444-4444-4444-8444-444444444444:11111111-1111-4111-8111-111111111111:once';

async function bal(ledger: MemoryLedger, account: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(account)).amount);
}

/** A rewards engine funded the way production funds it: fees swept into the pot. The customer holds 50 of their own. */
async function funded(pot = '1000'): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: PAYER, assetId: ASSET, amount: amt(pot), rail: 'crypto-native', railRef: 'tx-payer' }));
  await ledger.post(
    recipes.feeCharge({ chargeId: 'fee-1', userId: PAYER, module: 'campaigns', mode: 'asset', assetId: ASSET, amount: amt(pot) }),
  );
  await ledger.post(recipes.sweepFeesToRewards({ windowId: 'w1', sourceModule: 'campaigns', assetId: ASSET, amount: amt(pot) }));
  await ledger.post(recipes.deposit({ userId: CUSTOMER, assetId: ASSET, amount: amt('50'), rail: 'crypto-native', railRef: 'tx-own' }));
  return ledger;
}

const input = (amount: string, rewardKey = KEY) => ({ rewardKey, userId: CUSTOMER, assetId: ASSET, amount: amt(amount) });
const lock = (amount = '300', rewardKey = KEY) => recipes.campaignRewardLock(input(amount, rewardKey));
const unlock = (amount = '300', rewardKey = KEY) => recipes.campaignRewardUnlock(input(amount, rewardKey));
const forfeit = (amount = '300', rewardKey = KEY) => recipes.campaignRewardForfeit(input(amount, rewardKey));

describe('locked campaign rewards and bonuses (CM-payouts-ledger-01, CM-rewards-hub-02)', () => {
  it('lock moves the rewards engine into the reward pot and nothing into the customer balance', async () => {
    const ledger = await funded();
    const post = lock();
    expect(post.idempotencyKey).toBe(`campaigns:lock:${KEY}`);
    expect(post.module).toBe('campaigns');
    expect(post.reason).toBe('campaigns.reward.locked');
    expect(post.meta).toEqual({ rewardKey: KEY, userId: CUSTOMER });
    expect(campaignLockAccount(KEY, ASSET)).toEqual({
      ownerType: 'module',
      ownerId: `campaigns:lock:${KEY.replaceAll(':', '.')}`,
      assetId: ASSET,
      kind: 'available',
    });
    expect(post.entries).toHaveLength(2);
    await ledger.post(post);
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('700');
    expect(await bal(ledger, userAvailable(CUSTOMER, ASSET))).toBe('50');
    expect(await bal(ledger, campaignLockAccount(KEY, ASSET))).toBe('300');
    expect((await ledger.balances('user', CUSTOMER)).map((b) => formatAmount(b.amount))).toEqual(['50']);
  });

  it('a retried lock posts once', async () => {
    const ledger = await funded();
    const first = await ledger.post(lock());
    const again = await ledger.post(lock());
    expect(again.id).toBe(first.id);
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('700');
    expect(await bal(ledger, campaignLockAccount(KEY, ASSET))).toBe('300');
  });

  it('a lock larger than the rewards engine is refused and moves nothing', async () => {
    const ledger = await funded('100');
    await expect(ledger.post(lock('300'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('100');
    expect(await bal(ledger, campaignLockAccount(KEY, ASSET))).toBe('0');
  });

  it('unlock pays the pot to the customer available once', async () => {
    const ledger = await funded();
    await ledger.post(lock());
    const post = unlock();
    expect(post.idempotencyKey).toBe(`campaigns:unlock:${KEY}`);
    expect(post.reason).toBe('campaigns.reward.unlocked');
    await ledger.post(post);
    await ledger.post(post);
    expect(await bal(ledger, userAvailable(CUSTOMER, ASSET))).toBe('350');
    expect(await bal(ledger, campaignLockAccount(KEY, ASSET))).toBe('0');
  });

  it('forfeit returns the pot to the rewards engine once', async () => {
    const ledger = await funded();
    await ledger.post(lock());
    const post = forfeit();
    expect(post.idempotencyKey).toBe(`campaigns:forfeit:${KEY}`);
    expect(post.reason).toBe('campaigns.reward.forfeited');
    await ledger.post(post);
    await ledger.post(post);
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('1000');
    expect(await bal(ledger, userAvailable(CUSTOMER, ASSET))).toBe('50');
    expect(await bal(ledger, campaignLockAccount(KEY, ASSET))).toBe('0');
  });

  it('one outcome per lock: unlock then forfeit is refused, and forfeit then unlock is refused', async () => {
    const a = await funded();
    await a.post(lock());
    await a.post(unlock());
    await expect(a.post(forfeit())).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(a, rewardsEngine(ASSET))).toBe('700');
    expect(await bal(a, userAvailable(CUSTOMER, ASSET))).toBe('350');

    const b = await funded();
    await b.post(lock());
    await b.post(forfeit());
    await expect(b.post(unlock())).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(b, userAvailable(CUSTOMER, ASSET))).toBe('50');
  });

  it('a forfeited reward is never paid again: a second lock under the same key is the first post or a conflict', async () => {
    const ledger = await funded();
    const first = await ledger.post(lock());
    await ledger.post(forfeit());
    expect((await ledger.post(lock())).id).toBe(first.id);
    await expect(ledger.post(lock('200'))).rejects.toThrow(/already booked a different movement/);
    await expect(ledger.post(unlock())).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('1000');
    expect(await bal(ledger, campaignLockAccount(KEY, ASSET))).toBe('0');
  });

  it('an outcome never draws on another lock, nor on the customer own available', async () => {
    const ledger = await funded();
    await ledger.post(lock('100', KEY));
    await ledger.post(lock('400', OTHER_KEY));
    await expect(ledger.post(forfeit('300', KEY))).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(ledger.post(unlock('300', KEY))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(ledger, campaignLockAccount(KEY, ASSET))).toBe('100');
    expect(await bal(ledger, campaignLockAccount(OTHER_KEY, ASSET))).toBe('400');
    expect(await bal(ledger, userAvailable(CUSTOMER, ASSET))).toBe('50');
  });

  it('every post key of the longest reward key fits the 200-character wire key, and one more character refuses', () => {
    const longest = `task:${'a'.repeat(CAMPAIGN_REWARD_KEY_MAX - 'task:'.length)}`;
    for (const post of [lock('1', longest), unlock('1', longest), forfeit('1', longest)])
      expect(post.idempotencyKey.length).toBeLessThanOrEqual(200);
    expect(() => lock('1', `${longest}a`)).toThrow(InvalidEntryError);
    expect(() => recipes.campaignRewardLock({ ...input('1'), assetId: 'A'.repeat(17) })).toThrow(InvalidEntryError);
  });

  it('two reward keys never share a pot', () => {
    expect(campaignLockAccount('task:a:b-c', ASSET).ownerId).not.toBe(campaignLockAccount('task:a-b:c', ASSET).ownerId);
    expect(() => campaignLockAccount('task:a.b:c', ASSET)).toThrow(InvalidEntryError);
  });

  it('refuses a key that is not a stored reward key, a padded or non-UUID customer, a blank asset and non-positive amounts', () => {
    for (const rewardKey of ['', ' ', 'task', 'Task:a:b', 'task:a b:c', 'task:a.b', `task:${'a'.repeat(200)}`, 'task::x']) {
      expect(() => lock('1', rewardKey)).toThrow(InvalidEntryError);
    }
    for (const userId of ['', ` ${CUSTOMER}`, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'user-1']) {
      expect(() => recipes.campaignRewardUnlock({ ...input('1'), userId })).toThrow(InvalidEntryError);
    }
    for (const assetId of ['', ' ', ' USDT'])
      expect(() => recipes.campaignRewardLock({ ...input('1'), assetId })).toThrow(InvalidEntryError);
    expect(() => recipes.campaignRewardLock({ ...input('1'), amount: 0n })).toThrow(InvalidEntryError);
    expect(() => recipes.campaignRewardForfeit({ ...input('1'), amount: -1n })).toThrow(InvalidEntryError);
  });
});
