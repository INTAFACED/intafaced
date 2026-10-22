import { z } from 'zod';

/**
 * Typed Preview refusal (IA-SPEC 3.3), first used by BK-loan-09 in svc-bank; reusable by BK-cops-09, BK-bill-01 and other
 * "Preview · sample data" rows.
 *
 * A preview page sits at its final route with TEST-labelled sample data; every engine action on it is refused server-side
 * with this shape and nothing is written. It is deliberately NOT a NotConnected (see `kyb-documents.ts`): the engine does
 * not exist yet, no outside dependency is missing, so it never carries an allowlist code.
 *
 * Reads return it as one member of their output union; mutations throw PRECONDITION_FAILED with the message prefix
 * `preview.engine_not_built — <engine>:<action>` and the parsed refusal as the cause, like other typed codes.
 */
export const PREVIEW_REFUSAL_CODE = 'preview.engine_not_built' as const;

/** The banner text every preview page and refusal carries. */
export const PREVIEW_LABEL = 'Preview · sample data' as const;

/** Engine id `<module>.<engine>`, e.g. `bank.loan_schedule`. Names the missing engine, never a vendor. */
export const previewEngineIdSchema = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/, 'engine ids are <module>.<engine> in lower-case snake case');

export const previewRefusalSchema = z
  .object({
    kind: z.literal('preview'),
    code: z.literal(PREVIEW_REFUSAL_CODE),
    engine: previewEngineIdSchema,
    /** The refused action, e.g. `change_repayment_date`. */
    action: z
      .string()
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'actions are lower-case snake case'),
    label: z.literal(PREVIEW_LABEL),
  })
  .strict();
export type PreviewRefusal = z.infer<typeof previewRefusalSchema>;

/** Build the refusal a service returns or throws. Throws on a malformed engine id or action. */
export function previewRefusal(engine: string, action: string): PreviewRefusal {
  return previewRefusalSchema.parse({ kind: 'preview', code: PREVIEW_REFUSAL_CODE, engine, action, label: PREVIEW_LABEL });
}

export function isPreviewRefusal(value: unknown): value is PreviewRefusal {
  return previewRefusalSchema.safeParse(value).success;
}
