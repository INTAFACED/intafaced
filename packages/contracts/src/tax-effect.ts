import { z } from 'zod';

/**
 * RC-portfolio-02: the tax-effect map shape. Labels only: which ledger posting is a P2P sale or purchase, a card
 * spend, a mining payout or a staking reward, and whether it is a disposal, an acquisition or income. No rates, no
 * thresholds, no amounts. A posting with no row is `portfolio.tax_effect_unmapped`.
 */
export const TAX_EFFECT_TYPES = ['p2p_sale', 'p2p_purchase', 'card_spend', 'mining_payout', 'staking_reward'] as const;
export type TaxEffectType = (typeof TAX_EFFECT_TYPES)[number];

export const TAX_EFFECTS = ['disposal', 'acquisition', 'income'] as const;
export type TaxEffect = (typeof TAX_EFFECTS)[number];

export const TAX_EFFECT_UNMAPPED = 'portfolio.tax_effect_unmapped' as const;

export const taxEffectRowSchema = z.object({
  type: z.enum(TAX_EFFECT_TYPES),
  effect: z.enum(TAX_EFFECTS),
  /** The ledger `module/reason` the row reads, or null while no product posts one. */
  sourceEvent: z.string().nullable(),
  /** The leg on the user's own account that carries the effect (book convention: debit = in). */
  direction: z.enum(['debit', 'credit']).nullable(),
  /** Rails the row is limited to; null = any rail. */
  rails: z.array(z.string()).nullable(),
  /** Why the row classifies nothing yet; null when it is live. */
  blocker: z.string().nullable(),
});
export type TaxEffectRow = z.infer<typeof taxEffectRowSchema>;

export const taxEffectMapSchema = z.object({
  rows: z.array(taxEffectRowSchema),
  unmappedCode: z.literal(TAX_EFFECT_UNMAPPED),
});

/** The tax effect carried on one activity line. */
export const lineTaxEffectSchema = z.union([
  z.object({ type: z.enum(TAX_EFFECT_TYPES), effect: z.enum(TAX_EFFECTS), sourceEvent: z.string() }).strict(),
  z.object({ code: z.literal(TAX_EFFECT_UNMAPPED) }).strict(),
]);
export type LineTaxEffect = z.infer<typeof lineTaxEffectSchema>;
