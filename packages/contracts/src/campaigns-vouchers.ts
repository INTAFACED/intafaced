import { z } from 'zod';
import { asset, campaignDecimal, id, iso } from './campaigns-base.js';
import { REWARD_STATES } from './campaigns-rewards.js';

// ── Vouchers (CM-vouchers-coupons-01, CM-campaign-types-01 T-3) ────────────────────────────────────────────────────

/** A voucher instance's states (ENGINE VC-1). Issuing publishes one; claim and use are J-campaigns-08. */
export const VOUCHER_STATES = [
  'generated',
  'published',
  'active',
  'claimed',
  'partially_used',
  'used',
  'expired',
  'forfeited',
  'deactivated',
] as const;
export type VoucherState = (typeof VOUCHER_STATES)[number];

/**
 * A fee-saver coupon's terms (CM-vouchers-coupons-02): `discountBps` of our builder fee off (a fraction of the fee, as a
 * rank's `feeDiscountBps` is), on up to `orders` venue orders. Only our builder fee: never the venue's own fee.
 */
export const feeSaverTermsSchema = z
  .object({ discountBps: z.number().int().min(1).max(10_000), orders: z.number().int().min(1).max(1000) })
  .strict();
export type FeeSaverTerms = z.infer<typeof feeSaverTermsSchema>;

/** A voucher's kind: `cash` redeems its face value through the reward saga; `fee_saver` lowers our builder fee. */
export const VOUCHER_KINDS = ['cash', 'fee_saver'] as const;
export type VoucherKind = (typeof VOUCHER_KINDS)[number];

/**
 * A voucher of a voucher campaign. It keeps the revision it was issued under and that revision's reward as its face value:
 * a later approved revision changes the vouchers issued after it, never one already published (T-3). The face value is a
 * counter, not a balance: nothing is held for it.
 */
export const campaignVoucherSchema = z.object({
  id,
  campaignId: id,
  code: z.string(),
  revision: z.number().int().positive(),
  /** A fee-saver's face is its orders: `{ asset: 'ORDERS', amount: '<orders>' }`; a cash voucher's is its reward. */
  face: z.object({ asset, amount: campaignDecimal }),
  kind: z.enum(VOUCHER_KINDS).default('cash'),
  feeSaver: feeSaverTermsSchema.nullable().default(null),
  state: z.enum(VOUCHER_STATES),
  issuedBy: z.string(),
  issuedAt: iso,
  /** The claim-by and use-by of the revision it was issued under; null reads "not set" and its claim refuses. */
  claimBy: iso.nullable().default(null),
  useBy: iso.nullable().default(null),
});
export type CampaignVoucher = z.infer<typeof campaignVoucherSchema>;

/**
 * A campaign's limits (CM-eligibility-rules-03, eligibility-rules-008), owner values per campaign. `perCustomer`: at most
 * `count` rewards for one customer in any `periodSeconds` (a reward, a welcome task or a voucher redemption each count
 * once); either blank refuses activation `campaigns.per_customer_limit_unset`, never a default. `totalRedemptions`: at
 * most this many for everyone together; null means the budget is the only cap. Over either, the claim or redemption
 * refuses `campaigns.customer_limit_reached` or `campaigns.redemption_limit_reached`. The budget is the spend cap, and a
 * customer joins a campaign once.
 */
export const campaignLimitsSchema = z
  .object({
    perCustomer: z
      .object({
        count: z.number().int().min(1).max(1_000_000).nullable(),
        periodSeconds: z.number().int().min(60).max(31_536_000).nullable(),
      })
      .strict()
      .nullable(),
    totalRedemptions: z.number().int().min(1).max(100_000_000).nullable(),
  })
  .strict();
export type CampaignLimits = z.infer<typeof campaignLimitsSchema>;

/** A voucher campaign's claim-by and use-by times, as stored; either may be blank. A fee-saver campaign has its terms. */
export const voucherWindowSchema = z.object({
  claimBy: iso.nullable(),
  useBy: iso.nullable(),
  feeSaver: feeSaverTermsSchema.nullable().optional(),
});
export type VoucherWindow = z.infer<typeof voucherWindowSchema>;

/** A voucher code: 4 to 32 letters, digits or hyphens, stored upper case. With the campaign it is the issue's business key. */
export const voucherCode = z.string().regex(/^[A-Za-z0-9-]{4,32}$/);
export const voucherIssueInputSchema = z.object({ campaignId: id, code: voucherCode }).strict();
/** The most vouchers one read lists, newest first; the screen says when a campaign has at least this many. */
export const VOUCHER_LIST_LIMIT = 500;

export const voucherListInputSchema = z.object({ campaignId: id }).strict();

/**
 * The customer's voucher doors (J-campaigns-08). A code is only ever checked or claimed by the caller for their own
 * account. Every check and claim counts against the owner's attempt limits per account and per source address over the
 * owner's window (blank refuses `campaigns.attempt_limit_unset`; over a limit, `campaigns.attempt_limit_reached`). Anything about a code the caller may not claim (no such code, claimed by anyone, past its claim-by, or its
 * campaign not live) is one generic refusal, `campaigns.voucher_invalid`, so a guess learns nothing about other people.
 */
export const voucherCodeInputSchema = z.object({ code: voucherCode }).strict();

/** What a claimable code would give. Checking it changes nothing. */
export const voucherValidationSchema = z.object({
  claimable: z.literal(true),
  campaignName: z.string(),
  face: z.object({ asset, amount: campaignDecimal }),
  claimBy: iso,
  useBy: iso,
  /** A fee-saver coupon's terms (J-campaigns-09); null for a cash voucher. */
  feeSaver: feeSaverTermsSchema.nullable().default(null),
});
export type VoucherValidation = z.infer<typeof voucherValidationSchema>;

/**
 * One redemption of a voucher: the n-th use, under the business key `voucher:<voucher>:<account>:<n>` (ledger key
 * `reward:` and that), paid by the reward saga like any reward (its record is in My rewards too). An account that is not
 * active gets its redemption `withheld` before any ledger call.
 */
export const voucherRedemptionSchema = z.object({
  sequence: z.number().int().positive(),
  amount: campaignDecimal,
  createdAt: iso,
  reward: z.object({
    rewardKey: z.string(),
    state: z.lazy(() => z.enum(REWARD_STATES)),
    reason: z.string().nullable(),
    ledgerTxId: z.string().nullable(),
    postedAt: iso.nullable(),
    /** A USDC redemption on the launch path (J-campaigns-08 #5): when INTAFACED recorded it owed, under its ledger transaction. */
    owed: z.object({ txId: z.string(), at: iso }).nullable().default(null),
    /** Its one payment to the connected wallet, once paid: the chain transaction, the wallet and when. */
    payout: z.object({ chainTx: z.string(), toWallet: z.string(), at: iso }).nullable().default(null),
  }),
});
export type VoucherRedemption = z.infer<typeof voucherRedemptionSchema>;

/** A voucher in the caller's wallet: its face value, what is left, its dates and every redemption, oldest first. */
export const myVoucherSchema = z.object({
  id,
  code: z.string(),
  campaignId: id,
  campaignName: z.string(),
  state: z.enum(VOUCHER_STATES),
  face: z.object({ asset, amount: campaignDecimal }),
  used: campaignDecimal,
  remaining: campaignDecimal,
  claimedAt: iso,
  useBy: iso,
  expiredAt: iso.nullable(),
  redemptions: z.array(voucherRedemptionSchema),
  kind: z.enum(VOUCHER_KINDS).default('cash'),
  /**
   * A fee-saver coupon (J-campaigns-09 #1): what it takes off our builder fee, on how many orders, and each order it was
   * taken on, oldest first. `used` and `remaining` then count orders. Null for a cash voucher.
   */
  feeSaver: z
    .object({
      discountBps: z.number().int().min(1).max(10_000),
      orders: z.number().int().min(1),
      uses: z.array(z.object({ sequence: z.number().int().positive(), orderKey: z.string(), at: iso })),
    })
    .nullable()
    .default(null),
});
export type MyVoucher = z.infer<typeof myVoucherSchema>;

/** The most vouchers the wallet lists, newest claim first. */
export const MY_VOUCHERS_LIMIT = 200;
export const myVouchersSchema = z.object({ vouchers: z.array(myVoucherSchema) });
export type MyVouchers = z.infer<typeof myVouchersSchema>;

/**
 * Redeems part or all of what is left. `sequence` is the n-th redemption of this voucher (1 for the first): with the
 * voucher it is the business key, so the same request again returns the first answer (`created: false`).
 */
export const voucherRedeemInputSchema = z
  .object({ voucherId: id, amount: z.string().max(40), sequence: z.number().int().min(1).max(1000) })
  .strict();
export const voucherRedeemResultSchema = z.object({
  redemption: voucherRedemptionSchema,
  voucher: myVoucherSchema,
  created: z.boolean(),
});
export type VoucherRedeemResult = z.infer<typeof voucherRedeemResultSchema>;
