/**
 * Typed Preview refusal (IA-SPEC 3.3). WIP placeholder: replace with the Contracts bot branch.
 */
import { z } from 'zod';

/** One code for every preview engine action. Not on the NotConnected allowlist, never shown as one. */
export const PREVIEW_REFUSAL_CODE = 'preview.engine_not_built' as const;

/** The banner text every preview page and refusal carries. */
export const PREVIEW_LABEL = 'Preview · sample data' as const;

/** Engine id: `<module>.<engine>`, e.g. `bank.loan_schedule`, `bank.card_fraud_score`. */
export const previewEngineIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/)
  .max(80);

export const previewRefusalSchema = z
  .object({
    kind: z.literal('preview'),
    code: z.literal(PREVIEW_REFUSAL_CODE),
    /** Which engine would serve this action; names the missing engine, never a vendor. */
    engine: previewEngineIdSchema,
    /** The action that was refused, e.g. `change_repayment_date`. */
    action: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(64),
    label: z.literal(PREVIEW_LABEL),
  })
  .strict();
export type PreviewRefusal = z.infer<typeof previewRefusalSchema>;

/** Build the refusal a service returns or throws. */
export function previewRefusal(engine: string, action: string): PreviewRefusal {
  return previewRefusalSchema.parse({ kind: 'preview', code: PREVIEW_REFUSAL_CODE, engine, action, label: PREVIEW_LABEL });
}

export function isPreviewRefusal(value: unknown): value is PreviewRefusal {
  return previewRefusalSchema.safeParse(value).success;
}
