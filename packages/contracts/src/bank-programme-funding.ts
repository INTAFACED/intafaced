import { z } from 'zod';
import { bankCardFundsScopeSchema } from './bank-card-funds.js';
import { payAmountStringSchema, payAssetCodeSchema, payRequestIdSchema } from './merchant-control.js';

/**
 * BK-cops-04 (second contracts part): card programme funding model and programme transfers, owned by svc-bank.
 * The read shapes (card funds view, card balances) are in bank-card-funds.ts. No figure, limit or default is set here:
 * programme transfer limits are owner values held by svc-bank, and a blank limit refuses `bank.programme_limit_unset`.
 */

/**
 * How card spend is funded. Only `jit` runs today: the card is an access device and spend is held and captured from the
 * customer's own ledger balance. Setting any other model refuses `bank.funding_model_not_wired`.
 */
export const BANK_PROGRAMME_FUNDING_MODELS = ['prefunded_pooled', 'jit', 'credit'] as const;
export const bankProgrammeFundingModelSchema = z.enum(BANK_PROGRAMME_FUNDING_MODELS);
export type BankProgrammeFundingModel = z.infer<typeof bankProgrammeFundingModelSchema>;

export const BANK_PROGRAMME_REFUSAL_CODES = [
  /** No programme transfer limit is set for this asset; nothing is assumed. */
  'bank.programme_limit_unset',
  /** The two sides of a programme transfer hold different assets and no conversion is used. */
  'bank.programme_transfer_asset_mismatch',
  /** The requested funding model is not built yet; only `jit` runs. */
  'bank.funding_model_not_wired',
] as const;
export type BankProgrammeRefusalCode = (typeof BANK_PROGRAMME_REFUSAL_CODES)[number];

const timestamp = z.string().datetime({ offset: true });
const approvalField = z.string().min(1).max(128);

export const bankProgrammeFundingModelViewSchema = z
  .object({
    current: bankProgrammeFundingModelSchema,
    /** Plain words for the operator: how spend is funded under the current model. */
    explanation: z.string().min(1),
    /** Models that can be set in this deployment; a model not listed refuses `bank.funding_model_not_wired`. */
    wired: z.array(bankProgrammeFundingModelSchema).min(1),
    changedAt: timestamp.nullable(),
    changedBy: z.string().min(1).nullable(),
  })
  .strict()
  .refine((v) => v.wired.includes(v.current), { path: ['wired'], message: 'The current model must be wired' });
export type BankProgrammeFundingModelView = z.infer<typeof bankProgrammeFundingModelViewSchema>;

/** A funding model change needs an action approval from a second operator. */
export const bankProgrammeFundingModelSetInputSchema = z
  .object({
    model: bankProgrammeFundingModelSchema,
    reason: z.string().trim().min(10).max(500),
    approvalId: approvalField,
    operationId: approvalField,
  })
  .strict();
export type BankProgrammeFundingModelSetInput = z.infer<typeof bankProgrammeFundingModelSetInputSchema>;

/** One side of a programme transfer: the programme reserve, a business, or an individual. */
export const bankProgrammeTransferPartySchema = bankCardFundsScopeSchema;
export type BankProgrammeTransferParty = z.infer<typeof bankProgrammeTransferPartySchema>;

function sameParty(a: BankProgrammeTransferParty, b: BankProgrammeTransferParty): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Idempotent on `programme-transfer:<from>:<to>:<requestId>`; a retry with the same requestId returns the same transfer. */
export const bankProgrammeTransferInputSchema = z
  .object({
    from: bankProgrammeTransferPartySchema,
    to: bankProgrammeTransferPartySchema,
    assetCode: payAssetCodeSchema,
    amount: payAmountStringSchema.refine((a) => /[1-9]/.test(a), 'amount must be above zero'),
    requestId: payRequestIdSchema,
  })
  .strict()
  .refine((t) => !sameParty(t.from, t.to), { path: ['to'], message: 'from and to must differ' });
export type BankProgrammeTransferInput = z.infer<typeof bankProgrammeTransferInputSchema>;

/**
 * `posted`: the ledger booked it (`ledgerTxId` set). `unknown`: the post outcome is not known; the intent and hold are
 * kept and only the reconciler resolves it, so a retry never posts twice.
 */
export const bankProgrammeTransferSchema = z
  .object({
    requestId: payRequestIdSchema,
    from: bankProgrammeTransferPartySchema,
    to: bankProgrammeTransferPartySchema,
    assetCode: payAssetCodeSchema,
    amount: payAmountStringSchema,
    status: z.enum(['posted', 'unknown']),
    ledgerTxId: z.string().min(1).nullable(),
    createdAt: timestamp,
  })
  .strict()
  .refine((t) => (t.status === 'posted') === (t.ledgerTxId !== null), {
    path: ['ledgerTxId'],
    message: 'A posted transfer has a ledger transaction; an unknown one has none',
  });
export type BankProgrammeTransfer = z.infer<typeof bankProgrammeTransferSchema>;

export interface BankProgrammeFundingContract {
  programmeFundingModelGet(): Promise<BankProgrammeFundingModelView>;
  programmeFundingModelSet(input: BankProgrammeFundingModelSetInput): Promise<BankProgrammeFundingModelView>;
  programmeTransfer(input: BankProgrammeTransferInput): Promise<BankProgrammeTransfer>;
}
