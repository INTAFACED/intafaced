import { z } from 'zod';
import { payAmountStringSchema, payAssetCodeSchema } from './merchant-control.js';

/**
 * BK-cops-04 (read-only part): card funds view and card balances, owned by svc-bank.
 * A card is an access device: spend is held and captured from the customer's ledger balance; no service holds a
 * card balance. Every figure is read from the ledger and carried as a decimal string, never a JSON number.
 * Programme transfers and the funding model setting are left for a later contracts PR.
 */
const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });

/** Signed decimal string, used only for a reconciliation difference. */
export const bankSignedAmountStringSchema = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'signed decimal string with at most 18 places');

export const bankCardFundsScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('programme') }).strict(),
  z.object({ kind: z.literal('business'), businessId: id }).strict(),
  z.object({ kind: z.literal('individual'), userId: id }).strict(),
]);
export type BankCardFundsScope = z.infer<typeof bankCardFundsScopeSchema>;

export const bankCardFundsViewInputSchema = z
  .object({ scope: bankCardFundsScopeSchema, assetCode: payAssetCodeSchema.optional() })
  .strict();
export type BankCardFundsViewInput = z.infer<typeof bankCardFundsViewInputSchema>;

/** Held versus captured per asset; `difference` = ledger total - (held + captured), zero when reconciled. */
export const bankCardFundsRowSchema = z
  .object({
    assetCode: payAssetCodeSchema,
    held: payAmountStringSchema,
    heldCount: z.number().int().nonnegative().safe(),
    captured: payAmountStringSchema,
    capturedCount: z.number().int().nonnegative().safe(),
    ledgerTotal: payAmountStringSchema,
    difference: bankSignedAmountStringSchema,
  })
  .strict();
export type BankCardFundsRow = z.infer<typeof bankCardFundsRowSchema>;

export const bankCardFundsViewSchema = z
  .object({ scope: bankCardFundsScopeSchema, readAt: timestamp, rows: z.array(bankCardFundsRowSchema) })
  .strict()
  .refine((view) => new Set(view.rows.map((r) => r.assetCode)).size === view.rows.length, { path: ['rows'], message: 'One row per asset' });
export type BankCardFundsView = z.infer<typeof bankCardFundsViewSchema>;

export const bankCardBalancesInputSchema = bankCardFundsViewInputSchema;
export type BankCardBalancesInput = z.infer<typeof bankCardBalancesInputSchema>;

/** Ledger, available and pending per asset, read from the ledger. */
export const bankCardBalanceRowSchema = z
  .object({
    assetCode: payAssetCodeSchema,
    ledger: payAmountStringSchema,
    available: payAmountStringSchema,
    pending: payAmountStringSchema,
  })
  .strict();
export type BankCardBalanceRow = z.infer<typeof bankCardBalanceRowSchema>;

export const bankCardBalancesSchema = z
  .object({ scope: bankCardFundsScopeSchema, readAt: timestamp, rows: z.array(bankCardBalanceRowSchema) })
  .strict()
  .refine((view) => new Set(view.rows.map((r) => r.assetCode)).size === view.rows.length, { path: ['rows'], message: 'One row per asset' });
export type BankCardBalances = z.infer<typeof bankCardBalancesSchema>;

export interface BankCardFundsContract {
  cardFundsView(input: BankCardFundsViewInput): Promise<BankCardFundsView>;
  cardBalances(input: BankCardBalancesInput): Promise<BankCardBalances>;
}
