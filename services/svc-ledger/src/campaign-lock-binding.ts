/**
 * A locked campaign reward has one outcome, and it is the outcome of that lock (CM-payouts-ledger-01, CM-rewards-hub-02).
 *
 * The recipe gate knows a post by its shape, and its shape for an unlock or a forfeit matches every
 * `campaigns:lock:*` pot and any customer. Here the door reads the posted `campaigns:lock:<rewardKey>` and lets an
 * unlock or a forfeit through only out of that reward's own pot, in its asset, for the whole locked amount, and an
 * unlock only to the customer the lock names. A lock is refused when `rewardPay` already paid the same reward under
 * `reward:<rewardKey>`, so one reward is never both paid and locked. Anything else refuses before anything posts.
 */
import { LedgerError, campaignLockAccount, parseAmount, type LedgerTx } from '@intafaced/ledger-client';

export const CAMPAIGN_LOCK_UNBOUND_CODE = 'ledger.campaign_lock_unbound';

const LOCKED = 'campaigns.reward.locked';
const OUTCOMES: Readonly<Record<string, string>> = {
  'campaigns.reward.unlocked': 'campaigns:unlock:',
  'campaigns.reward.forfeited': 'campaigns:forfeit:',
};

interface WireLockPost {
  readonly idempotencyKey: string;
  readonly module: string;
  readonly reason: string;
  readonly entries: readonly {
    readonly account: { ownerType: string; ownerId?: string; assetId: string; kind: string; purpose?: string };
    readonly direction: string;
    readonly amount: string;
  }[];
  readonly meta?: Record<string, unknown>;
}

export interface CampaignLockReader {
  getTxByKey(idempotencyKey: string): Promise<LedgerTx | null>;
}

function refuse(why: string): never {
  throw new LedgerError(`A locked campaign reward must match its posted lock: ${why}`, CAMPAIGN_LOCK_UNBOUND_CODE);
}

function potOf(rewardKey: string, assetId: string): string {
  try {
    return campaignLockAccount(rewardKey, assetId).ownerId;
  } catch {
    return refuse('the reward key is not a stored reward key');
  }
}

export async function assertCampaignLockBound(ledger: CampaignLockReader, input: WireLockPost): Promise<void> {
  const outcomePrefix = OUTCOMES[input.reason];
  if (input.reason !== LOCKED && outcomePrefix === undefined) return;
  if (input.module !== 'campaigns') refuse('not the campaigns module');
  const meta = input.meta ?? {};
  const rewardKey = typeof meta.rewardKey === 'string' ? meta.rewardKey : '';
  const userId = typeof meta.userId === 'string' ? meta.userId : '';
  if (!rewardKey || !userId) refuse('no reward key or customer');
  if (input.entries.length !== 2) refuse('not the locked reward shape');
  const pot = input.entries.find((e) => e.account.ownerType === 'module');
  const other = input.entries.find((e) => e !== pot);
  if (!pot || !other) refuse('not the locked reward shape');
  const assetId = pot.account.assetId;
  if (pot.account.ownerId !== potOf(rewardKey, assetId)) refuse("another reward's pot");
  if (other.account.assetId !== assetId) refuse('the legs are in two assets');

  if (input.reason === LOCKED) {
    if (input.idempotencyKey !== `campaigns:lock:${rewardKey}`) refuse('the key does not name its reward');
    if (await ledger.getTxByKey(`reward:${rewardKey}`)) refuse('this reward was already paid');
    return;
  }

  if (input.idempotencyKey !== `${outcomePrefix}${rewardKey}`) refuse('the key does not name its reward');
  const lock = await ledger.getTxByKey(`campaigns:lock:${rewardKey}`);
  if (!lock || lock.module !== 'campaigns' || lock.reason !== LOCKED) refuse('no posted lock');
  if (lock.meta.userId !== userId) refuse('another customer');
  const locked = lock.entries.find((e) => e.direction === 'debit' && e.assetId === assetId);
  if (!locked) refuse('the lock is in another asset');
  if (parseAmount(pot.amount) !== locked.amount) refuse('not the whole locked amount');
  if (input.reason === 'campaigns.reward.unlocked' && (other.account.ownerType !== 'user' || other.account.ownerId !== userId)) {
    refuse('an unlock pays only the customer the lock names');
  }
}
