import { z } from 'zod';

/**
 * Wire shapes for withdrawal fee quotes (W-withdraw-04). Every input object is `.strict()`. Amounts are decimal strings,
 * never numbers. A blank fee mode or lifetime is not a parse default: it is the absence of a policy row.
 */
const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');
const assetId = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/);
const networkId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
/** The caller's own business key for one quote, kept across a retry so a retry reads the same quote. */
const quoteRef = z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/);
const clientRef = z.string().min(1).max(64);
/** The quote reference and network id a send names (J-wallet-05 #6), the same shapes a quote is stored under. */
export const sendQuoteRefSchema = quoteRef;
export const sendNetworkIdSchema = networkId;

export const FEE_MODES = ['on_top', 'deducted'] as const;
export type FeeMode = (typeof FEE_MODES)[number];

export const quoteInputSchema = z.object({ quoteRef, assetId, networkId, amount }).strict();
export type QuoteInput = z.infer<typeof quoteInputSchema>;

export const acceptInputSchema = z.object({ quoteRef, clientRef }).strict();
export type AcceptInput = z.infer<typeof acceptInputSchema>;

/** The owner's fee mode and quote lifetime. A lifetime in whole seconds is a positive integer or no policy at all. */
export const setPolicyInputSchema = z.object({ feeMode: z.enum(FEE_MODES), ttlSeconds: z.number().int().min(1).max(86_400) }).strict();
export type SetPolicyInput = z.infer<typeof setPolicyInputSchema>;

export const listInputSchema = z
  .object({ userId: z.string().guid().optional(), assetId: assetId.optional(), limit: z.number().int().min(1).max(200) })
  .strict();
export type ListInput = z.infer<typeof listInputSchema>;

export const FEE_KINDS = ['network'] as const;

export const quoteViewSchema = z.object({
  quoteRef: z.string(),
  assetId: z.string(),
  networkId: z.string(),
  amount: z.string(),
  feeMode: z.enum(FEE_MODES),
  /**
   * The fee parts that apply today, each a decimal string in the withdrawn asset. Bank, conversion and other fees join
   * this list when a source for them exists; a part with no source is absent, never shown as zero.
   */
  fees: z.array(z.object({ kind: z.enum(FEE_KINDS), amount: z.string() })),
  feeTotal: z.string(),
  /** What reaches the destination: the amount when the fee is on top, the amount less the fee when deducted. */
  netAmount: z.string(),
  /** What leaves the customer's balance: the amount plus the fee when on top, the amount when deducted. */
  totalDebit: z.string(),
  feeSource: z.string(),
  quotedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  expired: z.boolean(),
  /** The client reference that accepted this quote, or null while unused. */
  acceptedBy: z.string().nullable(),
});
export type QuoteView = z.infer<typeof quoteViewSchema>;

export const policyViewSchema = z.object({
  /** Null while the owner has set none; a quote then refuses with `withdrawal_quote.policy_unset`. */
  feeMode: z.enum(FEE_MODES).nullable(),
  ttlSeconds: z.number().int().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string().datetime({ offset: true }).nullable(),
});
export type PolicyView = z.infer<typeof policyViewSchema>;

export const adminQuoteViewSchema = quoteViewSchema.extend({ userId: z.string().guid() });
export type AdminQuoteView = z.infer<typeof adminQuoteViewSchema>;
