import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError, isValidOwnerId } from '../types.js';
import { moduleAccount, rewardsEngine, userAvailable } from '../accounts.js';

/**
 * LOCKED CAMPAIGN REWARDS AND BONUSES (CM-payouts-ledger-01 locked part, CM-rewards-hub-02; J-campaigns-03 #4-#6).
 *
 * A locked reward or a bonus is not the customer's yet, so it does not sit in
 * any of their accounts. It moves from the rewards engine into a campaigns pot
 * of its own, one per reward (`campaigns:lock:<lockId>`), and waits there until
 * svc-campaigns decides it: the condition is met and it goes to the customer, or
 * the condition fails or the bonus expires and it goes back to the engine.
 * svc-campaigns owns the reward row, the condition and the expiry; these
 * recipes only fix the shape of each post.
 *
 *   lock     rewards engine           → `campaigns:lock:<lockId>`
 *   unlock   `campaigns:lock:<lockId>` → customer available
 *   forfeit  `campaigns:lock:<lockId>` → rewards engine
 *
 * Nothing here touches a customer balance except an unlock paying into one, so
 * no shape of these recipes can take a customer's own funds, and a locked bonus
 * can never be spent or withdrawn: it is not in the customer's available.
 * `module` accounts are hard non-negative, so an unlock or a forfeit cannot pay
 * out more than its own pot holds, and once one outcome has emptied the pot the
 * other is refused. Each outcome has one key per reward, so a second unlock or a
 * second forfeit under the same reward is the same post, never a new one: a
 * forfeited reward is never paid again. svc-ledger's door binds each outcome to
 * its posted lock (services/svc-ledger/src/campaign-lock-binding.ts): the same
 * customer, the same asset, the whole locked amount; and refuses a lock for a
 * reward already paid by `rewardPay` under `reward:<rewardKey>`.
 *
 * The lock id is the reward key with `:` written as `.`. Reward key segments
 * hold no `.`, so two reward keys never share a pot.
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

/** svc-campaigns' reward key (`task:<campaignId>:<accountId>:<period>`): a lowercase head, then colon-separated segments without `.`. */
const REWARD_KEY_PATTERN = /^[a-z][a-z0-9-]*(:[A-Za-z0-9_-]+)+$/;

/** The longest post key is `campaigns:forfeit:<rewardKey>`, and a post key is at most 200 characters on the wire. */
export const CAMPAIGN_REWARD_KEY_MAX = 200 - 'campaigns:forfeit:'.length;
/** The wire's asset id limit. */
const ASSET_MAX = 16;

function requireRewardKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > CAMPAIGN_REWARD_KEY_MAX || !REWARD_KEY_PATTERN.test(value)) {
    throw new InvalidEntryError('rewardKey must be the stored campaign reward key (e.g. `task:<campaignId>:<accountId>:once`)');
  }
  return value;
}

function requireUserId(value: unknown): string {
  if (typeof value !== 'string' || !isValidOwnerId('user', value)) {
    throw new InvalidEntryError('userId must be the customer id as stored (a lowercase UUID, no padding)');
  }
  return value;
}

function requireAsset(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > ASSET_MAX || value.trim() !== value) {
    throw new InvalidEntryError('assetId must be the stored asset id (not blank, no padding, at most 16 characters)');
  }
  return value;
}

function requirePositive(name: string, value: Amount): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

const lockPot = (rewardKey: string, assetId: string): AccountRef =>
  moduleAccount('campaigns', `lock:${rewardKey.replaceAll(':', '.')}`, assetId);

/** The campaigns pot for one locked reward or bonus. */
export function campaignLockAccount(rewardKey: string, assetId: string): AccountRef {
  return lockPot(requireRewardKey(rewardKey), requireAsset(assetId));
}

export interface CampaignLockInput {
  /** svc-campaigns' stored reward key. */
  rewardKey: string;
  /** The customer the reward belongs to: carried on the lock for audit, paid on the unlock. */
  userId: string;
  assetId: string;
  /** The amount svc-campaigns stored for this reward. */
  amount: Amount;
}

function checked(input: CampaignLockInput, label: string) {
  const rewardKey = requireRewardKey(input.rewardKey);
  const userId = requireUserId(input.userId);
  const assetId = requireAsset(input.assetId);
  requirePositive(label, input.amount);
  return { rewardKey, userId, assetId, lock: lockPot(rewardKey, assetId) };
}

/** Lock a reward: rewards engine → `campaigns:lock:<lockId>`. */
export function campaignRewardLock(input: CampaignLockInput): PostRequest {
  const p = checked(input, 'locked reward amount');
  return {
    idempotencyKey: `campaigns:lock:${p.rewardKey}`,
    module: 'campaigns',
    reason: 'campaigns.reward.locked',
    meta: { rewardKey: p.rewardKey, userId: p.userId },
    entries: [credit(rewardsEngine(p.assetId), input.amount), debit(p.lock, input.amount)],
  };
}

/** Unlock a reward whose condition was met: `campaigns:lock:<lockId>` → customer available. */
export function campaignRewardUnlock(input: CampaignLockInput): PostRequest {
  const p = checked(input, 'locked reward unlock amount');
  return {
    idempotencyKey: `campaigns:unlock:${p.rewardKey}`,
    module: 'campaigns',
    reason: 'campaigns.reward.unlocked',
    meta: { rewardKey: p.rewardKey, userId: p.userId },
    entries: [credit(p.lock, input.amount), debit(userAvailable(p.userId, p.assetId), input.amount)],
  };
}

/** Forfeit a reward whose condition failed or whose bonus expired: `campaigns:lock:<lockId>` → rewards engine. */
export function campaignRewardForfeit(input: CampaignLockInput): PostRequest {
  const p = checked(input, 'locked reward forfeit amount');
  return {
    idempotencyKey: `campaigns:forfeit:${p.rewardKey}`,
    module: 'campaigns',
    reason: 'campaigns.reward.forfeited',
    meta: { rewardKey: p.rewardKey, userId: p.userId },
    entries: [credit(p.lock, input.amount), debit(rewardsEngine(p.assetId), input.amount)],
  };
}
