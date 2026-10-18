import { formatAmount, parseAmount, recipes, userAvailable, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { PayError, type PayErrorCode } from '../payment-service.js';

/**
 * Customer wallet rules for svc-pay (slice S38).
 *
 * A blank owner figure is a refusal, never a zero. A read does not post.
 * A retry of an attempt still marked requested does not ask the rail again.
 *
 * `blocked` is the withdraw feature status published in the customer app
 * (apps/customer/src/app/feature-registry.ts, id `withdraw`, VERIFIED 2026-10-18).
 * `hidden` is the same door: a new withdrawal is unavailable, so it is refused.
 */
export const PUBLISHED_WITHDRAW_FEATURE_STATUS = 'blocked' as const;

export const ALLOWLIST_CALLBACK_TIMEOUT_MS = 5_000;

export type WithdrawFeatureStatus = 'live' | 'blocked' | 'hidden';

export type AttemptOutcome = 'requested' | 'accepted' | 'refused';

export interface WalletAttempt {
  outcome: AttemptOutcome;
  railRef: string | null;
}

export interface WalletWithdrawal {
  id: string;
  userId: string;
  assetId: string;
  network: string;
  amount: Amount;
  fee: Amount | null;
  clientRef: string;
  destinationRef: string;
  status: 'pending' | 'held' | 'sent' | 'failed' | 'cancelled' | 'needs-info';
  holdAmount: Amount;
  recipient: Record<string, string>;
  attempts: WalletAttempt[];
  reversed: boolean;
}

export interface WalletInbound {
  id: string;
  userId: string;
  assetId: string;
  network: string;
  amount: Amount;
  railRef: string;
  acceptanceAddress: string | null;
  status: 'uncredited' | 'credited' | 'refused';
  reason: string | null;
}

export interface WalletStore {
  getWithdrawal(id: string): Promise<WalletWithdrawal | null>;
  getWithdrawalByClient(userId: string, clientRef: string): Promise<WalletWithdrawal | null>;
  saveWithdrawal(row: WalletWithdrawal): Promise<void>;
  listWithdrawals(userId: string, assetId: string): Promise<WalletWithdrawal[]>;
  getInbound(railRef: string): Promise<WalletInbound | null>;
  saveInbound(row: WalletInbound): Promise<void>;
  listInbounds(): Promise<WalletInbound[]>;
}

export class MemoryWalletStore implements WalletStore {
  private readonly withdrawals = new Map<string, WalletWithdrawal>();
  private readonly byClient = new Map<string, string>();
  private readonly inbounds = new Map<string, WalletInbound>();

  async getWithdrawal(id: string): Promise<WalletWithdrawal | null> {
    const row = this.withdrawals.get(id);
    return row ? cloneWithdrawal(row) : null;
  }

  async getWithdrawalByClient(userId: string, clientRef: string): Promise<WalletWithdrawal | null> {
    const id = this.byClient.get(clientKey(userId, clientRef));
    return id ? this.getWithdrawal(id) : null;
  }

  async saveWithdrawal(row: WalletWithdrawal): Promise<void> {
    this.withdrawals.set(row.id, cloneWithdrawal(row));
    this.byClient.set(clientKey(row.userId, row.clientRef), row.id);
  }

  async listWithdrawals(userId: string, assetId: string): Promise<WalletWithdrawal[]> {
    return [...this.withdrawals.values()].filter((row) => row.userId === userId && row.assetId === assetId).map(cloneWithdrawal);
  }

  async getInbound(railRef: string): Promise<WalletInbound | null> {
    const row = this.inbounds.get(railRef);
    return row ? { ...row } : null;
  }

  async saveInbound(row: WalletInbound): Promise<void> {
    this.inbounds.set(row.railRef, { ...row });
  }

  async listInbounds(): Promise<WalletInbound[]> {
    return [...this.inbounds.values()].map((row) => ({ ...row }));
  }
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

export interface WalletRail {
  payout(input: {
    withdrawalId: string;
    userId: string;
    assetId: string;
    amount: Amount;
    destinationRef: string;
  }): Promise<{ ok: true; railRef: string; amount: Amount; assetId: string } | { ok: false }>;
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
  ledger: LedgerClient;
  store: WalletStore;
  publish: WalletPublish;
  chainReader: ChainReader;
  rail: WalletRail;
  allowlist: WalletAllowlist;
  now: () => Date;
  callbackTimeoutMs?: number;
}

/** A requested attempt is still in flight. Asking the rail again can send twice. */
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

function clientKey(userId: string, clientRef: string): string {
  return `${userId}\n${clientRef}`;
}

function cloneWithdrawal(row: WalletWithdrawal): WalletWithdrawal {
  return {
    ...row,
    recipient: { ...row.recipient },
    attempts: row.attempts.map((attempt) => ({ ...attempt })),
  };
}

export class WalletPay {
  constructor(private readonly deps: WalletDeps) {}

  /** SUP-0012, WAL-0162. A read posts nothing and never adds a recall control. */
  async supportRead(input: { withdrawalId: string; ownerUserId: string }): Promise<{
    withdrawalId: string;
    userId: string;
    label: 'irreversible' | 'unknown';
    controls: string[];
    attempts: WalletAttempt[];
    status: WalletWithdrawal['status'];
  }> {
    const row = await this.mustWithdrawal(input.withdrawalId);
    if (row.userId !== input.ownerUserId) {
      refuse('This withdrawal belongs to another account', 'pay.wallet_forbidden');
    }
    const label = await supportLabel(row.attempts, this.deps.chainReader);
    return {
      withdrawalId: row.id,
      userId: row.userId,
      label,
      controls: [],
      attempts: row.attempts.map((attempt) => ({ ...attempt })),
      status: row.status,
    };
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
    const open = await this.openHold(userId, assetId);
    const remaining = cap > open ? cap - open : 0n;
    return formatAmount(remaining);
  }

  /**
   * Fresh customer withdrawal. Refusals happen before a hold and before the rail.
   * The same client ref does not open a second hold.
   */
  async submitWithdrawal(input: CustomerWithdrawalInput): Promise<WalletWithdrawal> {
    const existing = await this.deps.store.getWithdrawalByClient(input.userId, input.clientRef);
    if (existing) {
      if (railRetryWhileRequested(existing.attempts[existing.attempts.length - 1]?.outcome) === 'unknown') {
        refuse('A withdrawal attempt is already requested; the rail is not asked again', 'pay.rail_outcome_unknown', {
          withdrawalId: existing.id,
        });
      }
      return existing;
    }

    const destinationRef = await this.assertCustomerWithdrawal(input);
    const fee = publishedAmount(this.deps.publish.networkFee(input.assetId, input.network, destinationRef));
    const id = crypto.randomUUID();
    const row: WalletWithdrawal = {
      id,
      userId: input.userId,
      assetId: input.assetId,
      network: input.network,
      amount: input.amount,
      fee,
      clientRef: input.clientRef,
      destinationRef,
      status: 'pending',
      holdAmount: 0n,
      recipient: filledRecipient(input.recipient),
      attempts: [],
      reversed: false,
    };
    await this.deps.ledger.post(
      recipes.withdrawHold({
        userId: row.userId,
        assetId: row.assetId,
        amount: row.amount,
        rail: 'crypto-native',
        withdrawalId: row.id,
      }),
    );
    row.status = 'held';
    row.holdAmount = row.amount;
    row.attempts.push({ outcome: 'requested', railRef: null });
    await this.deps.store.saveWithdrawal(row);

    const result = await this.deps.rail.payout({
      withdrawalId: row.id,
      userId: row.userId,
      assetId: row.assetId,
      amount: row.amount,
      destinationRef,
    });
    if (!result.ok || result.amount !== row.amount || result.assetId !== row.assetId || !result.railRef.trim()) {
      row.attempts[0] = { outcome: 'requested', railRef: null };
      await this.deps.store.saveWithdrawal(row);
      refuse('The rail did not accept this withdrawal', 'pay.rail_outcome_unknown', { withdrawalId: row.id });
    }
    await this.deps.ledger.post(
      recipes.withdrawSettle({
        userId: row.userId,
        assetId: row.assetId,
        amount: row.amount,
        rail: 'crypto-native',
        withdrawalId: row.id,
      }),
    );
    row.status = 'sent';
    row.holdAmount = 0n;
    row.attempts[0] = { outcome: 'accepted', railRef: result.railRef };
    await this.deps.store.saveWithdrawal(row);
    return row;
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

  /** WAL-0048, WAL-0088. Cancel before an accepted rail receipt. The hold reverses once. */
  async cancelWithdrawal(input: { withdrawalId: string; userId: string }): Promise<WalletWithdrawal> {
    const row = await this.mustOwn(input.withdrawalId, input.userId);
    const latest = row.attempts[row.attempts.length - 1];
    if (row.status === 'cancelled') return row;
    if (row.status === 'sent' || latest?.outcome === 'accepted') {
      refuse('A sent withdrawal cannot be cancelled', 'pay.wallet_cancel_refused');
    }
    if (latest?.outcome === 'requested') {
      refuse('The rail result is unknown, so this withdrawal cannot be cancelled', 'pay.wallet_cancel_refused');
    }
    if (row.status !== 'pending' && row.status !== 'held') {
      refuse('This withdrawal cannot be cancelled', 'pay.wallet_cancel_refused');
    }
    if (row.holdAmount > 0n && !row.reversed) {
      await this.deps.ledger.post(
        recipes.withdrawReverse({
          userId: row.userId,
          assetId: row.assetId,
          amount: row.holdAmount,
          rail: 'crypto-native',
          withdrawalId: row.id,
        }),
      );
      row.holdAmount = 0n;
      row.reversed = true;
    }
    row.status = 'cancelled';
    await this.deps.store.saveWithdrawal(row);
    return row;
  }

  /** WAL-0057. A sent withdrawal is not credited back without the reverse recipe and a chain-return proof. */
  async adminCreditSent(input: {
    withdrawalId: string;
    reason: string | null;
    chainReturnProof: string | null;
  }): Promise<WalletWithdrawal> {
    const row = await this.mustWithdrawal(input.withdrawalId);
    if (row.status !== 'sent') refuse('Only a sent withdrawal is considered here', 'pay.wallet_sent_credit_refused');
    const reason = input.reason?.trim() ?? '';
    const proof = input.chainReturnProof?.trim() ?? '';
    if (!reason || !proof) {
      refuse(
        'A sent withdrawal is not credited back without a recorded reason and a proved chain return',
        'pay.wallet_sent_credit_refused',
      );
    }
    if (row.reversed) return row;
    if (row.holdAmount <= 0n) {
      refuse('The hold is already settled, so this credit is refused', 'pay.wallet_sent_credit_refused');
    }
    if (!row.reversed && row.holdAmount > 0n) {
      await this.deps.ledger.post(
        recipes.withdrawReverse({
          userId: row.userId,
          assetId: row.assetId,
          amount: row.holdAmount,
          rail: 'crypto-native',
          withdrawalId: row.id,
        }),
      );
      row.holdAmount = 0n;
      row.reversed = true;
      await this.deps.store.saveWithdrawal(row);
    }
    return row;
  }

  /** WAL-0117. Needs-info keeps the hold and does not settle. Unnamed fields are not stored. */
  async markNeedsInfo(input: { withdrawalId: string; fields: Record<string, string> }): Promise<WalletWithdrawal> {
    const row = await this.mustWithdrawal(input.withdrawalId);
    const allowed = new Set(this.deps.publish.travelRuleFields);
    for (const key of Object.keys(input.fields)) {
      if (!allowed.has(key)) refuse(`The owner schema does not name ${key}`, 'pay.wallet_field_unnamed', { field: key });
    }
    if (row.status === 'sent') refuse('A sent withdrawal cannot be marked needs-info', 'pay.wallet_needs_info');
    row.recipient = { ...row.recipient, ...input.fields };
    row.status = 'needs-info';
    await this.deps.store.saveWithdrawal(row);
    return row;
  }

  async settleWithdrawal(withdrawalId: string): Promise<void> {
    const row = await this.mustWithdrawal(withdrawalId);
    if (row.status === 'needs-info') refuse('A needs-info withdrawal is not settled', 'pay.wallet_needs_info');
    refuse('Settle is refused from this door', 'pay.wallet_needs_info');
  }

  /**
   * WAL-0007, WAL-0008, WAL-0155, WAL-0166.
   * Blank minimum refuses. Below minimum and tier none stay uncredited.
   * A finalized inbound to an acceptance address credits once, with or without a session.
   */
  async deliverInbound(input: {
    userId: string;
    assetId: string;
    network: string;
    amount: Amount;
    railRef: string;
    acceptanceAddress: string | null;
    finalized: boolean;
    sessionOpen: boolean;
  }): Promise<WalletInbound> {
    // An open session is not required. A finalized inbound still credits while the user is offline.
    void input.sessionOpen;
    const existing = await this.deps.store.getInbound(input.railRef);
    if (existing?.status === 'credited') return existing;

    if (this.deps.publish.kycTier(input.userId) === 'none') {
      return this.saveUncredited(existing, input, 'kyc-tier-none');
    }

    const minimum = publishedAmount(this.deps.publish.depositMinimum(input.assetId, input.network));
    if (minimum === null) {
      refuse('The owner minimum for this asset and network is not set', 'pay.wallet_minimum_unset');
    }
    if (input.amount < minimum) return this.saveUncredited(existing, input, 'below-minimum');
    if (!input.finalized) return this.saveUncredited(existing, input, 'not-final');
    const address = input.acceptanceAddress?.trim() ?? '';
    if (!address || !this.deps.publish.acceptanceAddresses.has(address)) {
      return this.saveUncredited(existing, input, 'unmatched');
    }

    await this.deps.ledger.post(
      recipes.deposit({
        userId: input.userId,
        assetId: input.assetId,
        amount: input.amount,
        rail: 'crypto-native',
        railRef: input.railRef,
      }),
    );
    const credited: WalletInbound = {
      id: existing?.id ?? crypto.randomUUID(),
      userId: input.userId,
      assetId: input.assetId,
      network: input.network,
      amount: input.amount,
      railRef: input.railRef,
      acceptanceAddress: address,
      status: 'credited',
      reason: null,
    };
    await this.deps.store.saveInbound(credited);
    return credited;
  }

  async listUncredited(): Promise<WalletInbound[]> {
    const rows = await this.deps.store.listInbounds();
    return rows.filter((row) => row.status === 'uncredited');
  }

  async available(userId: string, assetId: string): Promise<Amount> {
    return (await this.deps.ledger.balance(userAvailable(userId, assetId))).amount;
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

  private async openHold(userId: string, assetId: string): Promise<Amount> {
    const rows = await this.deps.store.listWithdrawals(userId, assetId);
    return rows.reduce((sum, row) => {
      if (row.status === 'cancelled' || row.status === 'sent' || row.status === 'failed') return sum;
      return sum + row.holdAmount;
    }, 0n);
  }

  private async saveUncredited(
    existing: WalletInbound | null,
    input: {
      userId: string;
      assetId: string;
      network: string;
      amount: Amount;
      railRef: string;
      acceptanceAddress: string | null;
    },
    reason: string,
  ): Promise<WalletInbound> {
    const row: WalletInbound = {
      id: existing?.id ?? crypto.randomUUID(),
      userId: input.userId,
      assetId: input.assetId,
      network: input.network,
      amount: input.amount,
      railRef: input.railRef,
      acceptanceAddress: input.acceptanceAddress,
      status: 'uncredited',
      reason,
    };
    await this.deps.store.saveInbound(row);
    return row;
  }

  private async mustWithdrawal(id: string): Promise<WalletWithdrawal> {
    const row = await this.deps.store.getWithdrawal(id);
    if (!row) refuse(`Withdrawal ${id} not found`, 'pay.wallet_not_found');
    return row;
  }

  private async mustOwn(id: string, userId: string): Promise<WalletWithdrawal> {
    const row = await this.mustWithdrawal(id);
    if (row.userId !== userId) refuse('This withdrawal belongs to another account', 'pay.wallet_forbidden');
    return row;
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
