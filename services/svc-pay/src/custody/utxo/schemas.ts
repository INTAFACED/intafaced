import { z } from 'zod';

/**
 * Wire shapes for `founderAdmin.custody.utxo.*` (W-custody-ops-13). Every input object is `.strict()`. Amounts are decimal
 * strings, never numbers. A consolidation trigger is never defaulted: no trigger row is the blank state.
 */
const walletId = z.string().guid();
const networkId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const decimal = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places')
  .refine((v) => /[1-9]/.test(v), 'must be above zero');
const reason = z.string().trim().min(1).max(500);

export const UTXO_STATES = ['available', 'reserved', 'spent'] as const;
export type UtxoState = (typeof UTXO_STATES)[number];

export const utxoListInputSchema = z.object({ walletId, state: z.enum(UTXO_STATES).optional() }).strict();
export type UtxoListInput = z.infer<typeof utxoListInputSchema>;

export const utxoViewSchema = z.object({
  id: z.string().guid(),
  walletId: z.string().guid(),
  txid: z.string(),
  vout: z.number().int(),
  amount: z.string(),
  confirmations: z.number().int(),
  state: z.enum(UTXO_STATES),
  label: z.string().nullable(),
  firstSeenAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }),
});
export type UtxoView = z.infer<typeof utxoViewSchema>;

export const utxoLabelInputSchema = z.object({ utxoId: z.string().guid(), label: z.string().trim().min(1).max(100).nullable() }).strict();
export type UtxoLabelInput = z.infer<typeof utxoLabelInputSchema>;

/** At least one trigger is set. A fee trigger carries the unit the estimator reports in. */
export const triggerSetInputSchema = z
  .object({
    networkId,
    minUtxoCount: z.number().int().min(2).max(100_000).optional(),
    feeBelow: decimal.optional(),
    feeUnit: z.string().trim().min(1).max(32).optional(),
    reason,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.minUtxoCount === undefined && v.feeBelow === undefined) {
      ctx.addIssue({ code: 'custom', path: ['minUtxoCount'], message: 'set a UTXO count, a low-fee level, or both' });
    }
    if ((v.feeBelow === undefined) !== (v.feeUnit === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['feeUnit'], message: 'a low-fee level and its unit go together' });
    }
  });
export type TriggerSetInput = z.infer<typeof triggerSetInputSchema>;

export const triggerKeyInputSchema = z.object({ networkId }).strict();

export const triggerViewSchema = z.object({
  networkId: z.string(),
  /** False while the owner has set none; a consolidation then refuses `utxo.triggers_unset`. */
  configured: z.boolean(),
  minUtxoCount: z.number().int().nullable(),
  feeBelow: z.string().nullable(),
  feeUnit: z.string().nullable(),
  reason: z.string().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string().datetime({ offset: true }).nullable(),
});
export type TriggerView = z.infer<typeof triggerViewSchema>;

export const dueInputSchema = z.object({ walletId }).strict();
export const dueViewSchema = z.object({
  due: z.boolean(),
  reasons: z.array(z.enum(['utxo_count', 'low_fee'])),
  /** Confirmed, available outputs counted against the UTXO trigger. */
  utxoCount: z.number().int(),
  /** Why the fee trigger could not be read (estimator unwired, down or in another unit), else null. */
  feeNote: z.string().nullable(),
});
export type DueView = z.infer<typeof dueViewSchema>;

export const consolidateInputSchema = z
  .object({ walletId, intentRef: z.string().regex(/^[A-Za-z0-9:_.-]{1,128}$/, 'the intent reference is your own business key') })
  .strict();
export type ConsolidateInput = z.infer<typeof consolidateInputSchema>;

export const consolidationViewSchema = z.object({
  id: z.string().guid(),
  intentRef: z.string(),
  walletId: z.string().guid(),
  inputCount: z.number().int(),
  totalAmount: z.string(),
  /** `intent`: written, no outcome yet; a retry with the same reference resumes it. */
  status: z.enum(['intent', 'broadcast', 'failed']),
  txid: z.string().nullable(),
  failureCode: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});
export type ConsolidationView = z.infer<typeof consolidationViewSchema>;
