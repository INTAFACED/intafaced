import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { PayError, type PayErrorCode } from '../payment-service.js';

/**
 * Customer wallet reads for svc-pay (slice S38).
 *
 * A blank owner figure is a refusal, never a zero. A read does not post.
 * A retry of an attempt still marked requested does not ask the rail again.
 *
 * This file no longer gates a send. Its customer door (`assertCustomerWithdrawal`, with a published feature status, a
 * per-account switch, a stored destination with a cooling window, a cap, a shown fee, travel-rule fields and an allowlist
 * callback) read sources nothing ever published, so it refused every send. J-wallet-05 #6 (issue #6517) replaced it with the
 * checks that read real sources: the custody signer per network and the address book (`withdrawals/send-out/`), the accepted
 * quote and its fee (the claim), and the guards already in the claim (limits, allowlist, approvals, custody policy,
 * screening, halts, treasury, purchase holds).
 */

export type AttemptOutcome = 'requested' | 'accepted' | 'refused';

export interface WalletAttempt {
  outcome: AttemptOutcome;
  railRef: string | null;
}

export interface WalletPublish {
  /** Decimal string, or null when the owner left the figure blank. */
  networkFee: (assetId: string, chain: string, address: string) => string | null;
  withdrawalCap: (userId: string, assetId: string) => string | null;
}

export interface ChainReader {
  confirm(txHash: string): Promise<'confirmed' | 'down'>;
}

export interface WalletDeps {
  publish: WalletPublish;
  /**
   * Sum of this user's open withdrawal holds for the asset, from the one real
   * withdrawal table (`pay.withdrawals`, status pending or held). The cap check
   * counts these, so the figure checked is the figure the book holds.
   */
  openHolds: (userId: string, assetId: string) => Promise<Amount>;
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

/** Nothing published: the fee estimate and the cap both refuse. The fee a send carries is its quote's (`withdrawal.quote`). */
export function failClosedWalletPublish(): WalletPublish {
  return {
    networkFee: () => null,
    withdrawalCap: () => null,
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
  constructor(private readonly deps: WalletDeps) {}

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
    const open = await this.deps.openHolds(userId, assetId);
    const remaining = cap > open ? cap - open : 0n;
    return formatAmount(remaining);
  }
}
