import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { PayError, type PayErrorCode } from '../payment-service.js';

/**
 * Customer wallet rules for svc-pay (slice S38).
 *
 * A blank owner figure is a refusal, never a zero. A read does not post.
 * A retry of an attempt still marked requested does not ask the rail to pay again.
 *
 * `blocked` is the withdraw feature status published in the customer app
 * (apps/customer/src/app/feature-registry.ts, id `withdraw`, VERIFIED 2026-10-18).
 * `hidden` is the same door: a new withdrawal is unavailable, so it is refused.
 *
 * This module does not post. Holds, settles, reverses and deposits go through
 * UserMoneyService and PayService only.
 */
export const PUBLISHED_WITHDRAW_FEATURE_STATUS = 'blocked' as const;

export const ALLOWLIST_CALLBACK_TIMEOUT_MS = 5_000;

export type WithdrawFeatureStatus = 'live' | 'blocked' | 'hidden';

export type AttemptOutcome = 'requested' | 'accepted' | 'refused';

export interface WalletAttempt {
  outcome: AttemptOutcome;
  railRef: string | null;
}

export interface StoredDestination {
  ref: string;
  updatedAt: Date;
}

export interface WalletPublish {
  withdrawFeatureStatus: WithdrawFeatureStatus;
  /** Decimal string, or null when the owner left the figure blank. */
  depositMinimum: (assetId: string, network: string) => string | null;
  networkFee: (assetId: string, chain: string, address: string) => string | null;
  withdrawalCap: (userId: string, assetId: string) => string | null;
  withdrawEnabled: (userId: string) => boolean;
  /** Positive integer hours, or null when the owner left the window blank. */
  coolingHours: number | null;
  storedDestination: (userId: string, assetId: string, network: string) => StoredDestination | null;
  kycTier: (userId: string) => 'none' | 'basic' | 'full' | 'institutional';
  acceptanceAddresses: ReadonlySet<string>;
  travelRuleFields: readonly string[];
  railRequiresBeneficiary: boolean;
}

export interface ChainReader {
  confirm(txHash: string): Promise<'confirmed' | 'down'>;
}

export interface WalletAllowlist {
  has(userId: string, address: string): boolean;
}

export interface CustomerWithdrawalInput {
  userId: string;
  assetId: string;
  network: string;
  amount: Amount;
  clientRef: string;
  /** Present when the caller typed an address instead of using the stored destination. */
  typedAddress?: string | null;
  shownFee?: string | null;
  recipient?: Record<string, string | undefined>;
  destinationAdheres?: boolean | 'timeout';
  allowlistCallback?: () => Promise<string>;
  railRequiresBeneficiary?: boolean;
}

export interface WalletDeps {
  publish: WalletPublish;
  allowlist: WalletAllowlist;
  now: () => Date;
  /**
   * Open holds already booked on `pay.withdrawals` for this user and asset.
   * UserMoneyService binds the sum of `pending` and `held` rows. A blank
   * implementation is not a zero: the caller must pass the real sum.
   */
  openHolds: (userId: string, assetId: string) => Promise<Amount>;
  callbackTimeoutMs?: number;
}

/** A requested attempt is still in flight. Asking the rail to pay again can send twice. */
export function railRetryWhileRequested(outcome: string | null | undefined): 'unknown' | 'ask' {
  return outcome === 'requested' ? 'unknown' : 'ask';
}

/** Irreversible only when the latest attempt was accepted, the tx hash is stored, and the chain reader confirms it. */
export async function supportLabel(attempts: readonly WalletAttempt[], chainReader: ChainReader): Promise<'irreversible' | 'unknown'> {
  const latest = attempts[attempts.length - 1];
  if (latest?.outcome !== 'accepted' || !latest.railRef?.trim()) return 'unknown';
  try {
    return (await chainReader.confirm(latest.railRef)) === 'confirmed' ? 'irreversible' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function failClosedWalletPublish(status: WithdrawFeatureStatus = PUBLISHED_WITHDRAW_FEATURE_STATUS): WalletPublish {
  return {
    withdrawFeatureStatus: status,
    depositMinimum: () => null,
    networkFee: () => null,
    withdrawalCap: () => null,
    withdrawEnabled: () => false,
    coolingHours: null,
    storedDestination: () => null,
    kycTier: () => 'none',
    acceptanceAddresses: new Set<string>(),
    travelRuleFields: ['beneficiary_name', 'residential_address', 'wallet_type'],
    railRequiresBeneficiary: true,
  };
}

function refuse(message: string, code: PayErrorCode, detail?: Record<string, unknown>): never {
  throw new PayError(message, code, detail);
}

/** A blank or whitespace owner figure is unpublished. Zero is a published figure. */
export function publishedAmount(raw: string | null | undefined): Amount | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return parseAmount(trimmed);
}

export class WalletPay {
  private openHolds: WalletDeps['openHolds'];

  constructor(private readonly deps: WalletDeps) {
    this.openHolds = deps.openHolds;
  }

  /** The canonical door installs the `pay.withdrawals` sum. A wallet-store total is not used. */
  bindOpenHolds(openHolds: WalletDeps['openHolds']): void {
    this.openHolds = openHolds;
  }

  /** WAL-0079. The estimate is for this address and does not mark a withdrawal sent. */
  async estimateFee(input: { assetId: string; chain: string; address: string }): Promise<{
    fee: string;
    assetId: string;
    address: string;
    sent: false;
  }> {
    const fee = publishedAmount(this.deps.publish.networkFee(input.assetId, input.chain, input.address));
    if (fee === null) refuse('The network fee for this asset and address is not set', 'pay.wallet_fee_unset');
    return { fee: formatAmount(fee), assetId: input.assetId, address: input.address, sent: false };
  }

  /** The figure on the screen is the figure the cap check uses. */
  async remainingCap(userId: string, assetId: string): Promise<string> {
    const cap = publishedAmount(this.deps.publish.withdrawalCap(userId, assetId));
    if (cap === null) refuse('The withdrawal cap is not set', 'pay.wallet_cap_unset');
    const open = await this.openHolds(userId, assetId);
    const remaining = cap > open ? cap - open : 0n;
    return formatAmount(remaining);
  }

  /**
   * Throws the customer refusal, or returns the stored destination ref.
   * Does not post and does not ask the rail.
   */
  async assertCustomerWithdrawal(input: CustomerWithdrawalInput): Promise<string> {
    const publish = this.deps.publish;
    if (publish.withdrawFeatureStatus !== 'live') {
      refuse('A new withdrawal is unavailable', 'pay.wallet_withdraw_unavailable');
    }
    if (!publish.withdrawEnabled(input.userId)) {
      refuse('Withdrawals are turned off for this account', 'pay.wallet_withdraw_disabled');
    }

    const stored = publish.storedDestination(input.userId, input.assetId, input.network);
    const typed = input.typedAddress?.trim() ?? '';
    if (!stored) refuse('A withdrawal uses the stored destination', 'pay.wallet_typed_address');
    if (typed && typed !== stored.ref) refuse('A typed address is not the stored destination', 'pay.wallet_typed_address');
    this.assertCooling(stored);

    const capText = await this.remainingCap(input.userId, input.assetId);
    if (input.amount > parseAmount(capText)) {
      refuse('That amount is above the remaining withdrawal cap', 'pay.wallet_over_cap', { remainingCap: capText });
    }

    const fee = publishedAmount(publish.networkFee(input.assetId, input.network, stored.ref));
    if (fee === null) refuse('The network fee for this asset and address is not set', 'pay.wallet_fee_unset');
    const shown = publishedAmount(input.shownFee);
    if (shown === null || shown !== fee) {
      refuse('The shown network fee is not the fee that would be held', 'pay.wallet_fee_differs', {
        fee: formatAmount(fee),
      });
    }

    const requiresBeneficiary = input.railRequiresBeneficiary ?? publish.railRequiresBeneficiary;
    const missing = missingTravelFields(publish.travelRuleFields, input.recipient);
    if (missing.length > 0) {
      refuse('This withdrawal was unsuccessful. Submit it again with the missing details.', 'pay.wallet_travel_rule', {
        missingFields: missing,
      });
    }
    if (requiresBeneficiary && Object.keys(filledRecipient(input.recipient)).length === 0) {
      refuse('The rail asked for beneficiary data and the payload is blank', 'pay.wallet_travel_rule', {
        missingFields: [...publish.travelRuleFields],
      });
    }

    if (input.destinationAdheres === 'timeout') {
      refuse('The travel-rule payload was not shared in time', 'pay.wallet_share_timeout');
    }
    if (input.destinationAdheres !== true) {
      refuse('That destination does not accept the travel-rule payload', 'pay.wallet_destination_rejected');
    }

    if (!this.deps.allowlist.has(input.userId, stored.ref)) {
      refuse('That address is not on the allowlist', 'pay.wallet_allowlist');
    }
    const body = await this.allowlistBody(input.allowlistCallback);
    if (body !== 'ok') refuse('The allowlist did not approve this address', 'pay.wallet_allowlist');
    return stored.ref;
  }

  private assertCooling(stored: StoredDestination): void {
    const hours = this.deps.publish.coolingHours;
    if (hours === null || !Number.isInteger(hours) || hours <= 0) {
      refuse('The destination cooling window is not set', 'pay.wallet_cooling');
    }
    const opensAt = stored.updatedAt.getTime() + hours * 60 * 60 * 1000;
    if (this.deps.now().getTime() < opensAt) {
      refuse('That destination is still inside the cooling window', 'pay.wallet_cooling');
    }
  }

  private async allowlistBody(callback: (() => Promise<string>) | undefined): Promise<string> {
    if (!callback) return '';
    const timeoutMs = this.deps.callbackTimeoutMs ?? ALLOWLIST_CALLBACK_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(''), timeoutMs);
    });
    try {
      const body = await Promise.race([callback(), timeout]);
      return typeof body === 'string' ? body : '';
    } catch {
      return '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function filledRecipient(recipient: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!recipient) return out;
  for (const [key, value] of Object.entries(recipient)) {
    if (value?.trim()) out[key] = value.trim();
  }
  return out;
}

function missingTravelFields(required: readonly string[], recipient: Record<string, string | undefined> | undefined): string[] {
  return required.filter((name) => !recipient?.[name]?.trim());
}
