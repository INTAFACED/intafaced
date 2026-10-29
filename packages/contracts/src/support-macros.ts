/**
 * Support desk macros and agent signatures (SP-desk-02).
 *
 * A macro is a lead's saved reply text, filed under a folder, with placeholders such as `{{ticket.subject}}` that are
 * filled from the request it is applied to. Applying a macro only fills the agent's draft: nothing is sent until the
 * agent sends. An agent's signature is their own text, added under a public reply when it is sent and nowhere else.
 *
 * Browser safe: nothing here imports Node.
 *
 * - `support.macro_placeholder_unknown`: the macro names a placeholder outside `SUPPORT_MACRO_PLACEHOLDERS`. Nothing is
 *   saved; a macro is never stored with a placeholder that cannot be filled.
 * - `support.macro_revision_stale`: the macro or signature moved on since the writer read it. Nothing is saved.
 * - `support.macro_not_found`: no macro has this id.
 * - `support.macro_name_taken`: another macro already has this name. Nothing is saved.
 * - `support.not_lead`: only a lead writes macros. Any agent reads and applies them.
 */
import { z } from 'zod';

export const SUPPORT_MACRO_ERROR_CODES = [
  'support.macro_placeholder_unknown',
  'support.macro_revision_stale',
  'support.macro_not_found',
  'support.macro_name_taken',
  'support.not_lead',
] as const;
export type SupportMacroErrorCode = (typeof SUPPORT_MACRO_ERROR_CODES)[number];

/** Every placeholder a macro may name, each read from the request the macro is applied to. */
export const SUPPORT_MACRO_PLACEHOLDERS = ['ticket.subject', 'ticket.category'] as const;
export type SupportMacroPlaceholder = (typeof SUPPORT_MACRO_PLACEHOLDERS)[number];

const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The placeholders a macro body names, in order of first use. */
export function supportMacroPlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!))];
}

/** The placeholders a body names that no request can fill. Empty when every one is known. */
export function supportMacroUnknownPlaceholders(body: string): string[] {
  return supportMacroPlaceholders(body).filter((name) => !(SUPPORT_MACRO_PLACEHOLDERS as readonly string[]).includes(name));
}

/** The body with each known placeholder replaced by its value. An unknown placeholder is left as written. */
export function fillSupportMacro(body: string, values: Readonly<Record<SupportMacroPlaceholder, string>>): string {
  return body.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name as SupportMacroPlaceholder] : whole,
  );
}

/** The text a public reply is sent with: the draft, then the agent's signature under it when they have one. */
export function signedSupportReply(draft: string, signature: string | null): string {
  return signature === null ? draft : `${draft}\n\n${signature}`;
}

export const SUPPORT_MACRO_BODY_MAX = 5_000;
export const SUPPORT_SIGNATURE_MAX = 500;

const name = z.string().trim().min(1).max(80);

export const supportMacroSchema = z.object({
  id: z.string().guid(),
  name,
  /** Where the macro is filed in the desk's list; null when it is not in a folder. */
  folder: name.nullable(),
  body: z.string().min(1).max(SUPPORT_MACRO_BODY_MAX),
  revision: z.number().int().positive(),
  updatedBy: z.string().min(1),
  updatedAt: z.string().datetime(),
});
export type SupportMacro = z.infer<typeof supportMacroSchema>;

export const supportMacroListSchema = z.object({ macros: z.array(supportMacroSchema) });
export type SupportMacroList = z.infer<typeof supportMacroListSchema>;

export const supportMacroSaveInputSchema = z.object({
  /** Absent to create a macro. */
  macroId: z.string().guid().optional(),
  name,
  folder: name.nullable(),
  body: z.string().min(1).max(SUPPORT_MACRO_BODY_MAX),
  /** The revision the lead read: 0 to create. A moved revision refuses `support.macro_revision_stale`. */
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type SupportMacroSaveInput = z.infer<typeof supportMacroSaveInputSchema>;

export const supportMacroApplyInputSchema = z.object({ ticketId: z.string().guid(), macroId: z.string().guid() });

/** A macro filled for one request. Applying it writes nothing. */
export const supportMacroAppliedSchema = z.object({
  macroId: z.string().guid(),
  revision: z.number().int().positive(),
  text: z.string().min(1),
});
export type SupportMacroApplied = z.infer<typeof supportMacroAppliedSchema>;

/** The caller's own signature. `signature` is null until they set one; then nothing is added under their replies. */
export const supportSignatureSchema = z.object({
  signature: z.string().min(1).max(SUPPORT_SIGNATURE_MAX).nullable(),
  revision: z.number().int().nonnegative(),
});
export type SupportSignature = z.infer<typeof supportSignatureSchema>;

export const supportSignatureSetInputSchema = z.object({
  signature: z.string().trim().min(1).max(SUPPORT_SIGNATURE_MAX),
  /** The revision the agent read: 0 before their first signature. */
  expectedRevision: z.number().int().nonnegative(),
});
export type SupportSignatureSetInput = z.infer<typeof supportSignatureSetInputSchema>;
