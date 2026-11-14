import type { Amount } from '../money.js';
import { formatAmount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError, LedgerError, isValidOwnerId } from '../types.js';
import { moduleAccount, rewardsEngine } from '../accounts.js';
import { ownFundsPlaceAccount, type OwnFundsPlace } from './own-funds.js';

/**
 * A REWARD WE OWE A CUSTOMER, AND ITS PAYMENT TO THEIR OWN WALLET (launch money model; project-state OWNER.md item 288).
 *
 * At launch INTAFACED holds no customer money, so a reward, cashback, rebate, referral or prize is never credited to a
 * customer balance in our book. It is our liability to that customer until we pay it, in USDC, from one of our own-funds
 * places to the customer's own wallet:
 *
 *   fund   rewards engine                  → `campaigns:budget:<campaignId>`   (our money set aside for one campaign)
 *   owe    `campaigns:budget:<campaignId>` → `campaigns:owed:<rewardId>`       (what we owe, keyed by our decision record)
 *   pay    `campaigns:owed:<rewardId>`     → our own-funds place               (keyed by the chain transaction)
 *
 * Every leg is one of INTAFACED's own accounts (`module`, `house`, or an own-funds `treasury` place), so none of these
 * recipes moves a customer balance, none is in `customerBalanceRecipes`, and the custody guard needs no change. The
 * custodial reward recipes (`rewardPay`, `campaignRewardUnlock`) still credit a customer balance and stay refused while
 * the custodial layer is off; these do not replace or loosen them.
 *
 * Refusals:
 * - Owe is refused while the reward ceiling (per campaign or in total) is unset: `ledger.reward_ceiling_unset`. The
 *   ceiling is the owner's number; until it is given there is no default, so Owe refuses (AGENTS.md floor 8).
 * - Owe is refused when it would take the campaign's or all campaigns' owed rewards past the ceiling:
 *   `ledger.reward_ceiling_exceeded`.
 * - Owe is refused when the campaign's budget holds less than the amount: the budget is a `module` account, which the
 *   ledger never lets go below zero (`ledger.insufficient_funds`).
 * - Pay is refused when the book shows less than the amount at the paying place: an own-funds place may never show less
 *   than nothing of ours (`balanceAllowed`, `ledger.insufficient_funds`). Pay can never clear more than is owed for that
 *   reward either: the owed pot is a `module` account.
 */

/** Rewards pay in USDC at launch (OWNER 288). */
export const REWARD_ASSET = 'USDC';
const MODULE = 'campaigns';
const KEY_MAX = 200;

/** A campaign id: lowercase, no `:` or `.`, so pot names and keys stay unambiguous. */
const CAMPAIGN_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** Our decision record's business key: a lowercase head, the campaign id, then colon-separated segments without `.`. */
const REWARD_ID = /^[a-z][a-z0-9-]*(:[A-Za-z0-9_-]+)+$/;
/** A decision id or a chain transaction hash: no spaces, no `:`. */
const REFERENCE = /^[A-Za-z0-9_-]+$/;
/** An EVM wallet address. */
const WALLET_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const REWARD_CEILING_UNSET_CODE = 'ledger.reward_ceiling_unset';
export const REWARD_CEILING_EXCEEDED_CODE = 'ledger.reward_ceiling_exceeded';

/** Refused: the owner has not set the reward ceiling, so no reward can be owed. */
export class RewardCeilingUnsetError extends LedgerError {
  constructor(readonly missing: readonly ('perCampaign' | 'total')[]) {
    super(
      `A reward cannot be owed while the reward ceiling is unset (${missing.join(', ')}). The ceiling is the owner's number; ` +
        'it has no default, so every reward is refused until it is set.',
      REWARD_CEILING_UNSET_CODE,
    );
    this.name = 'RewardCeilingUnsetError';
  }
}

/** Refused: owing this reward would take what we owe past the ceiling. */
export class RewardCeilingExceededError extends LedgerError {
  constructor(
    readonly which: 'perCampaign' | 'total',
    readonly ceiling: Amount,
    readonly wouldOwe: Amount,
  ) {
    super(
      `Owing this reward would take the ${which === 'perCampaign' ? "campaign's" : 'total'} rewards owed to ` +
        `${formatAmount(wouldOwe)}, past the ceiling of ${formatAmount(ceiling)}.`,
      REWARD_CEILING_EXCEEDED_CODE,
    );
    this.name = 'RewardCeilingExceededError';
  }
}

/**
 * The owner's reward ceiling, in USDC. `null` or absent means unset, and unset refuses. Zero is a set ceiling that admits
 * nothing.
 */
export interface RewardCeiling {
  readonly perCampaign?: Amount | null;
  readonly total?: Amount | null;
}

/** The ceiling as it stands until the owner gives it: unset, so Owe refuses. */
export const REWARD_CEILING_UNSET: RewardCeiling = Object.freeze({ perCampaign: null, total: null });

function requireCampaignId(value: unknown): string {
  if (typeof value !== 'string' || !CAMPAIGN_ID.test(value)) {
    throw new InvalidEntryError('campaignId must be the stored campaign id (lowercase, no `:` or `.`)');
  }
  return value;
}

function requireRewardId(value: unknown, campaignId: string): string {
  if (typeof value !== 'string' || !REWARD_ID.test(value)) {
    throw new InvalidEntryError('rewardId must be the decision record key (e.g. `campaign:<campaignId>:<accountId>:<task>`)');
  }
  if (value.split(':')[1] !== campaignId) throw new InvalidEntryError("rewardId must name the reward's own campaign");
  return value;
}

function requireReference(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !REFERENCE.test(value)) {
    throw new InvalidEntryError(`${name} must be the outside record's id (no spaces or colons, at most 128 characters)`);
  }
  return value;
}

function requireUsdc(value: unknown): string {
  if (value !== REWARD_ASSET) throw new InvalidEntryError(`rewards are owed and paid in ${REWARD_ASSET} only`);
  return value;
}

function requirePositive(name: string, value: Amount): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new InvalidEntryError(`${name} must be above zero`);
}

function requireKey(key: string): string {
  if (key.length > KEY_MAX) throw new InvalidEntryError(`the post key would be longer than ${KEY_MAX} characters`);
  return key;
}

function requireRunningTotal(name: string, value: unknown): Amount {
  if (typeof value !== 'bigint' || value < 0n) throw new InvalidEntryError(`${name} must be what is owed so far, zero or more`);
  return value;
}

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

/** One campaign's budget: our money set aside for its rewards. */
export function campaignBudgetAccount(campaignId: string): AccountRef {
  return moduleAccount(MODULE, `budget:${requireCampaignId(campaignId)}`, REWARD_ASSET);
}

/** What we owe for one reward. The reward id is written with `:` as `.`; reward ids hold no `.`, so two never share a pot. */
export function rewardOwedAccount(rewardId: string): AccountRef {
  if (typeof rewardId !== 'string' || !REWARD_ID.test(rewardId)) throw new InvalidEntryError('rewardId must be the decision record key');
  return moduleAccount(MODULE, `owed:${rewardId.replaceAll(':', '.')}`, REWARD_ASSET);
}

export interface CampaignBudgetFundInput {
  readonly campaignId: string;
  /** Our decision to set this money aside (the campaign's approval record). */
  readonly decisionId: string;
  readonly assetId: string;
  readonly amount: Amount;
}

/** Set our money aside for one campaign: rewards engine → `campaigns:budget:<campaignId>`. */
export function campaignBudgetFund(input: CampaignBudgetFundInput): PostRequest {
  const campaignId = requireCampaignId(input.campaignId);
  const decisionId = requireReference('decisionId', input.decisionId);
  const assetId = requireUsdc(input.assetId);
  requirePositive('campaign budget amount', input.amount);
  return {
    idempotencyKey: requireKey(`campaigns:budget-fund:${campaignId}:${decisionId}`),
    module: MODULE,
    reason: 'campaigns.budget.funded',
    meta: { campaignId, decisionId },
    entries: [credit(rewardsEngine(assetId), input.amount), debit(campaignBudgetAccount(campaignId), input.amount)],
  };
}

export interface RewardOweInput {
  readonly campaignId: string;
  /** Our decision record's business key for this reward. One reward is owed once. */
  readonly rewardId: string;
  /** The customer we owe it to: carried in the entry, never a balance of theirs. */
  readonly userId: string;
  /** Why: reward, cashback, rebate, referral or prize. */
  readonly kind: 'reward' | 'cashback' | 'rebate' | 'referral' | 'prize';
  readonly assetId: string;
  readonly amount: Amount;
  /** The owner's ceiling. Unset refuses. */
  readonly ceiling: RewardCeiling;
  /** What this campaign and all campaigns owe in rewards so far, read from the book by the caller, before this one. */
  readonly owedSoFar: { readonly campaign: Amount; readonly total: Amount };
}

const KINDS = new Set(['reward', 'cashback', 'rebate', 'referral', 'prize']);

/** Owe a reward: `campaigns:budget:<campaignId>` → `campaigns:owed:<rewardId>`. Refused while the ceiling is unset. */
export function rewardOwe(input: RewardOweInput): PostRequest {
  const campaignId = requireCampaignId(input.campaignId);
  const rewardId = requireRewardId(input.rewardId, campaignId);
  if (typeof input.userId !== 'string' || !isValidOwnerId('user', input.userId)) {
    throw new InvalidEntryError('userId must be the customer id as stored (a lowercase UUID)');
  }
  if (!KINDS.has(input.kind)) throw new InvalidEntryError('kind must be reward, cashback, rebate, referral or prize');
  const assetId = requireUsdc(input.assetId);
  requirePositive('reward owed amount', input.amount);

  const perCampaign = input.ceiling?.perCampaign ?? null;
  const total = input.ceiling?.total ?? null;
  const missing = [...(perCampaign === null ? ['perCampaign' as const] : []), ...(total === null ? ['total' as const] : [])];
  if (missing.length > 0) throw new RewardCeilingUnsetError(missing);
  if (typeof perCampaign !== 'bigint' || perCampaign < 0n || typeof total !== 'bigint' || total < 0n) {
    throw new InvalidEntryError('the reward ceiling must be an amount of zero or more');
  }
  const campaignSoFar = requireRunningTotal('owedSoFar.campaign', input.owedSoFar?.campaign);
  const totalSoFar = requireRunningTotal('owedSoFar.total', input.owedSoFar?.total);
  if (campaignSoFar > totalSoFar) throw new InvalidEntryError("one campaign cannot owe more than all campaigns' total");
  if (campaignSoFar + input.amount > perCampaign) {
    throw new RewardCeilingExceededError('perCampaign', perCampaign, campaignSoFar + input.amount);
  }
  if (totalSoFar + input.amount > total) throw new RewardCeilingExceededError('total', total, totalSoFar + input.amount);

  return {
    idempotencyKey: requireKey(`campaigns:owe:${rewardId}`),
    module: MODULE,
    reason: 'campaigns.reward.owed',
    meta: { campaignId, rewardId, userId: input.userId, kind: input.kind },
    entries: [credit(campaignBudgetAccount(campaignId), input.amount), debit(rewardOwedAccount(rewardId), input.amount)],
  };
}

export interface RewardPayOutInput {
  readonly rewardId: string;
  /** Where we pay from: one of our own-funds places. */
  readonly from: OwnFundsPlace;
  /** The customer's own wallet the chain transaction paid. */
  readonly toWallet: string;
  /** The chain transaction that paid it. */
  readonly chainTx: string;
  readonly assetId: string;
  readonly amount: Amount;
}

/** Pay a reward we owe, from one of our own-funds places to the customer's own wallet: `campaigns:owed:<rewardId>` → the place. */
export function rewardPayOut(input: RewardPayOutInput): PostRequest {
  const owed = rewardOwedAccount(input.rewardId);
  const chainTx = requireReference('chainTx', input.chainTx);
  if (typeof input.toWallet !== 'string' || !WALLET_ADDRESS.test(input.toWallet)) {
    throw new InvalidEntryError("toWallet must be the customer's own wallet address (0x and 40 hex characters)");
  }
  const assetId = requireUsdc(input.assetId);
  requirePositive('reward payment amount', input.amount);
  const place = ownFundsPlaceAccount(input.from, assetId);
  return {
    // Keyed by the chain transaction alone (the money model's "keyed by the chain transaction"): one transfer books one
    // payment, so the same transaction can never be booked against a second reward (the ledger refuses the same key with
    // another body). The reward is in the entries and the meta. A reward id with the transaction would pass the key's
    // 200 characters for a campaign task reward (`campaign:<uuid>:task-<uuid>-<uuid>-once`).
    idempotencyKey: requireKey(`campaigns:reward-paid:${chainTx}`),
    module: MODULE,
    reason: 'campaigns.reward.paid_out',
    meta: { rewardId: input.rewardId, from: place.ownerId, toWallet: input.toWallet, chainTx },
    // What we owe comes down; the paying place's balance comes back toward zero (less of ours there). Both are refused
    // by the ledger if they would show less than nothing.
    entries: [credit(owed, input.amount), debit(place, input.amount)],
  };
}
