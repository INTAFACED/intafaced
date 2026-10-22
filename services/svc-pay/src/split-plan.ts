/**
 * M-plat-org-15 (partial): split payments and split refunds between a platform
 * and its sub-merchants — the CHECK and PLAN half only.
 *
 * Nothing here posts, holds or moves money. Split creation always ends in a
 * typed refusal today, because the two things it needs do not exist yet:
 *  - the owner's platform fee table (unpublished; blank stays a refusal), and
 *  - the lead's ledger recipe for split legs (`socket.payfac-split-fee-recipes`
 *    in `payfac-permissions.ts`).
 * Everything that CAN be checked before those exist is checked first, so a
 * bad split is refused for its real reason, before any hold.
 *
 * Money is `Amount` (bigint at ledger-client scale) end to end. Never a JS number.
 */
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { SETTLING_PARTY_SELF } from './submerchants.js';

export type SplitRefusalCode =
  | 'pay.split_invalid_amount'
  | 'pay.split_multi_asset'
  | 'pay.split_duplicate_party'
  | 'pay.split_sum_mismatch'
  | 'pay.split_settling_party_unsupported'
  | 'pay.split_fee_table_not_set'
  | 'pay.split_refund_exceeds_payment'
  | 'pay.split_refund_balance_short';

export class SplitRefusal extends Error {
  constructor(
    message: string,
    readonly code: SplitRefusalCode,
    readonly detail: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'SplitRefusal';
  }
}

export interface SplitShareInput {
  subMerchantId: string;
  amount: string;
  asset: string;
}

export interface SplitInput {
  paymentAmount: string;
  asset: string;
  settlingParty: string;
  platformFee: { amount: string; asset: string };
  shares: readonly SplitShareInput[];
}

/** Owner fee table. `null` = not published, which is the only state today. */
export type PlatformFeeTable = { published: true } | null;

function amount(raw: string, field: string): Amount {
  let v: Amount;
  try {
    v = parseAmount(raw);
  } catch {
    throw new SplitRefusal(`${field} is not a valid amount.`, 'pay.split_invalid_amount', { field });
  }
  if (v < 0n) throw new SplitRefusal(`${field} cannot be negative.`, 'pay.split_invalid_amount', { field });
  return v;
}

/**
 * Validate a split at creation. Order: amounts, one asset (D-143e), unique
 * parties, exact sum, settling party `self`, then the fee table. With the fee
 * table unpublished the last step always refuses; nothing is held or posted.
 */
export function checkSplitAtCreation(input: SplitInput, feeTable: PlatformFeeTable): never {
  const total = amount(input.paymentAmount, 'paymentAmount');
  if (total === 0n) throw new SplitRefusal('paymentAmount must be above zero.', 'pay.split_invalid_amount', { field: 'paymentAmount' });
  if (input.shares.length === 0)
    throw new SplitRefusal('A split needs at least one sub-merchant share.', 'pay.split_invalid_amount', { field: 'shares' });

  const assets = new Set([input.asset, input.platformFee.asset, ...input.shares.map((s) => s.asset)]);
  if (assets.size > 1) {
    throw new SplitRefusal(
      'Shares and the fee must all be in the payment asset; more than one asset is refused in v1.',
      'pay.split_multi_asset',
      { assets: [...assets].sort().join(',') },
    );
  }

  const seen = new Set<string>();
  let sum = amount(input.platformFee.amount, 'platformFee.amount');
  input.shares.forEach((s, i) => {
    if (seen.has(s.subMerchantId))
      throw new SplitRefusal('A sub-merchant appears twice in the split.', 'pay.split_duplicate_party', { subMerchantId: s.subMerchantId });
    seen.add(s.subMerchantId);
    sum += amount(s.amount, `shares[${i}].amount`);
  });
  if (sum !== total) {
    throw new SplitRefusal('Shares plus the platform fee must equal the payment exactly.', 'pay.split_sum_mismatch', {
      expected: formatAmount(total),
      got: formatAmount(sum),
    });
  }

  if (input.settlingParty !== SETTLING_PARTY_SELF) {
    throw new SplitRefusal(`Only settlingParty "${SETTLING_PARTY_SELF}" is supported.`, 'pay.split_settling_party_unsupported', {
      settlingParty: input.settlingParty,
    });
  }

  // Both today: fee table unpublished, and no split-leg ledger recipe exists.
  void feeTable;
  throw new SplitRefusal(
    'Split payments are not live: the platform fee table is not set and the split ledger recipe does not exist yet.',
    'pay.split_fee_table_not_set',
    { socket: 'socket.payfac-split-fee-recipes', feeTable: feeTable ? 'published' : 'not_set' },
  );
}

export interface SplitRefundLine {
  party: string; // sub-merchant id, or 'platform'
  amount: string;
}

/**
 * Plan a partial split refund: each share is reduced in proportion (floor),
 * and the rounding remainder is taken from the platform fee, stated as its own
 * line. Refuses — naming the party — if any sub-merchant balance is short; no
 * partial reversal is ever planned. Pure: returns a plan, posts nothing.
 */
export function planSplitRefund(args: {
  paymentAmount: string;
  platformFee: string;
  shares: readonly { subMerchantId: string; amount: string }[];
  refundAmount: string;
  balances: Readonly<Record<string, string>>;
}): { lines: SplitRefundLine[]; roundingToPlatform: string } {
  const total = amount(args.paymentAmount, 'paymentAmount');
  const refund = amount(args.refundAmount, 'refundAmount');
  if (refund === 0n || total === 0n)
    throw new SplitRefusal('refundAmount must be above zero.', 'pay.split_invalid_amount', { field: 'refundAmount' });
  if (refund > total)
    throw new SplitRefusal('The refund is larger than the payment.', 'pay.split_refund_exceeds_payment', {
      payment: formatAmount(total),
      refund: formatAmount(refund),
    });

  const lines: SplitRefundLine[] = [];
  let given = 0n;
  for (const s of args.shares) {
    const part = (amount(s.amount, 'share') * refund) / total;
    const bal = args.balances[s.subMerchantId];
    const have = bal === undefined ? 0n : amount(bal, `balances.${s.subMerchantId}`);
    if (have < part) {
      throw new SplitRefusal(`Sub-merchant ${s.subMerchantId} cannot cover its part of the refund.`, 'pay.split_refund_balance_short', {
        subMerchantId: s.subMerchantId,
        needed: formatAmount(part),
        available: formatAmount(have),
      });
    }
    lines.push({ party: s.subMerchantId, amount: formatAmount(part) });
    given += part;
  }
  const feeExact = (amount(args.platformFee, 'platformFee') * refund) / total;
  const platformPart = refund - given;
  lines.push({ party: 'platform', amount: formatAmount(platformPart) });
  return { lines, roundingToPlatform: formatAmount(platformPart - feeExact) };
}
