import type { Amount } from '../money.js';
import { formatAmount, mulBps } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError, LedgerError, isValidOwnerId } from '../types.js';
import { chargeReceivable, houseFees } from '../accounts.js';

/**
 * OUR FEE ON A PAYMENT A BUSINESS RECEIVED STRAIGHT INTO ITS OWN WALLET (launch money model, OWNER 226; J-merchant-04's Money
 * line: "the ledger records only INTAFACED's own fee on the payment, once under the payment's key; a fee left blank refuses
 * with a typed error").
 *
 * At launch a payer's crypto goes straight to an address of the business's own wallet. It never enters our book; only our
 * fee on it is ours, and the business owes it to us:
 *
 *   earn   `charge-receivable:<module>.<merchantId>` → `fees:<module>`   (keyed by our payment id)
 *
 * The receivable is the same boundary as a charge a customer owes us (`chargeReceivable`): its negative balance is exactly
 * what that business owes us, it may never go above zero, and `chargeCollect` brings it back when the fee is paid to one of
 * our own-funds places, keyed by that payment's own outside record. Earned and collected stay two figures; only a collect
 * says money arrived.
 *
 * Both legs are INTAFACED's own accounts (`house`, or a `treasury` boundary), so the recipe moves no customer balance, is not
 * in `customerBalanceRecipes`, and posts with the custodial layer off.
 *
 * Refusals:
 * - Earn is refused while the fee is blank (`ledger.merchant_fee_unset`). The fee is the owner's number (the business's
 *   pricing, or the published default); it has no default here (AGENTS.md floor 8). The recipe computes the fee from the rate
 *   and the payment's gross amount, so a caller cannot book a fee the rate does not give.
 * - A rate of zero, or a payment so small the fee rounds to zero, posts nothing: refused as an invalid entry.
 *
 * What it cannot check, because a recipe does not read the outside world: that the payment really arrived in the business's
 * wallet for that amount. Its caller (svc-pay's capture) books it only after the chain reported it final.
 */
const KEY_MAX = 200;
const MAX_BPS = 10_000;

/** A module id, as its fee pot names it (`fees:<module>`): lowercase, no `:` or `.`. */
const MODULE_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** Our payment id: no spaces, no `:`. */
const REF = /^[^\s:]{1,128}$/;

export const MERCHANT_FEE_UNSET_CODE = 'ledger.merchant_fee_unset';

/** Refused: the fee on this business's payments is blank, so nothing can be earned. */
export class MerchantFeeUnsetError extends LedgerError {
  constructor(readonly merchantId: string) {
    super(
      `Our fee on a payment to business ${merchantId} cannot be earned while the fee is blank. The fee is the owner's number; ` +
        'it has no default, so every fee is refused until it is set.',
      MERCHANT_FEE_UNSET_CODE,
    );
    this.name = 'MerchantFeeUnsetError';
  }
}

/** The fee on a business's payments, in basis points of the gross amount. `null` or absent means blank, and blank refuses. */
export interface MerchantFeeRate {
  readonly bps?: number | null;
}

function requireModule(module: unknown): string {
  if (typeof module !== 'string' || !MODULE_ID.test(module)) throw new InvalidEntryError('module must be a lower-case module id');
  return module;
}

function requireMerchant(merchantId: unknown): string {
  if (typeof merchantId !== 'string' || !isValidOwnerId('user', merchantId)) {
    throw new InvalidEntryError("merchantId must be the business's id as stored (a lowercase UUID)");
  }
  return merchantId;
}

function requireAsset(assetId: unknown): string {
  if (typeof assetId !== 'string' || !assetId.trim() || assetId.trim() !== assetId) {
    throw new InvalidEntryError('assetId is required, with no surrounding spaces');
  }
  return assetId;
}

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

/** What one business owes us in fees on payments to its own wallet, in one asset. */
export function merchantFeeReceivableAccount(module: string, merchantId: string, assetId: string): AccountRef {
  return chargeReceivable(requireModule(module), requireMerchant(merchantId), requireAsset(assetId));
}

/** The one key of our fee on one payment. */
export function earnedMerchantFeeKey(module: string, paymentId: string): string {
  return `merchant-fee:earned:${module}:${paymentId}`;
}

export interface MerchantFeeEarnInput {
  /** The module the payment belongs to (svc-pay posts `pay`): our fee lands in `fees:<module>`. */
  readonly module: string;
  readonly merchantId: string;
  /** Our payment id. One payment earns once. */
  readonly paymentId: string;
  readonly assetId: string;
  /** The payment's gross amount, as the chain reported it. The business's money: it never enters our book. */
  readonly grossAmount: Amount;
  /** The fee on this business's payments. Blank refuses. */
  readonly rate: MerchantFeeRate;
}

/** The fee `rate` gives on `grossAmount`, rounded down: we never book more fee than the rate gives. Blank refuses. */
export function merchantFeeOf(merchantId: string, grossAmount: Amount, rate: MerchantFeeRate): Amount {
  const bps = rate?.bps ?? null;
  if (bps === null) throw new MerchantFeeUnsetError(merchantId);
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS) throw new InvalidEntryError('the fee must be whole basis points from 0 to 10000');
  return mulBps(grossAmount, bps, 'floor');
}

/** Earn our fee on a payment to a business's own wallet: `charge-receivable:<module>.<merchantId>` → `fees:<module>`. */
export function merchantFeeEarn(input: MerchantFeeEarnInput): PostRequest {
  const module = requireModule(input.module);
  const merchantId = requireMerchant(input.merchantId);
  const assetId = requireAsset(input.assetId);
  if (typeof input.paymentId !== 'string' || !REF.test(input.paymentId)) {
    throw new InvalidEntryError('paymentId must be an id of at most 128 characters with no spaces or colons');
  }
  if (typeof input.grossAmount !== 'bigint' || input.grossAmount <= 0n) throw new InvalidEntryError('the payment must be above zero');
  const fee = merchantFeeOf(merchantId, input.grossAmount, input.rate);
  if (fee === 0n) throw new InvalidEntryError('our fee must be above zero; a payment with no fee posts nothing');

  const key = earnedMerchantFeeKey(module, input.paymentId);
  if (key.length > KEY_MAX) throw new InvalidEntryError(`the post key would be longer than ${KEY_MAX} characters`);
  return {
    idempotencyKey: key,
    module,
    reason: 'merchant_fee.earned',
    meta: { merchantId, paymentId: input.paymentId, grossAmount: formatAmount(input.grossAmount), rateBps: input.rate.bps! },
    entries: [debit(houseFees(module, assetId), fee), credit(merchantFeeReceivableAccount(module, merchantId, assetId), fee)],
  };
}
