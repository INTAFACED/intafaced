import { z } from 'zod';

/**
 * Typed Preview refusal (IA-SPEC 3.3), first used by BK-loan-09 in svc-bank.
 *
 * A preview page sits at its final route with sample data labelled TEST; any engine action on it is refused server-side
 * with this shape. It is never a NotConnected card and never carries an allowlist code: the engine does not exist yet,
 * no outside dependency is missing. Nothing is created by a refused call.
 */
export const PREVIEW_REFUSAL_COPY_SUFFIX = 'This is a preview with sample data.' as const;

const engineKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'engine keys are lower-case snake case');

export const previewRefusalSchema = z
  .object({
    kind: z.literal('preview'),
    /** The engine that does not exist yet (as named on the preview list). */
    engine: engineKey,
    /** The action the caller attempted, for the screen and the audit trail. */
    action: z.string().min(1).max(120),
    message: z.string().min(1).max(300),
  })
  .strict();
export type PreviewRefusal = z.infer<typeof previewRefusalSchema>;

export function previewRefusal(engine: string, action: string): PreviewRefusal {
  return previewRefusalSchema.parse({
    kind: 'preview',
    engine,
    action,
    message: `${action} is not built yet. ${PREVIEW_REFUSAL_COPY_SUFFIX}`,
  });
}

export function isPreviewRefusal(value: unknown): value is PreviewRefusal {
  return previewRefusalSchema.safeParse(value).success;
}

/** BK-loan-09 preview engines: the crypto-backed loan has no schedule, external repay or missed-payment engine. */
export const BANK_LOAN_PREVIEW_ENGINES = ['loan_schedule', 'loan_external_repay', 'loan_missed_payment'] as const;
export const bankLoanPreviewEngineSchema = z.enum(BANK_LOAN_PREVIEW_ENGINES);
export type BankLoanPreviewEngine = z.infer<typeof bankLoanPreviewEngineSchema>;
