/**
 * Support desk macros and agent signatures (SP-desk-02).
 *
 * A macro is saved reply text with a title, a shortcode and an optional folder. Its body may name placeholders from a
 * closed list, written `{{requester.name}}`, which svc-support fills from the request it is applied to. A value the
 * desk cannot read for that request stays in the draft unfilled, and svc-support refuses to send a reply that still
 * holds one: what the agent sees is what is sent, and a blank value is never sent empty or filled with a stand-in.
 * Applying a macro only fills the agent's draft; nothing is sent until the agent sends. An agent's signature is their
 * own text, put into the draft of a public reply when it is composed, so the reply carries exactly what the agent saw.
 *
 * Browser safe: nothing here imports Node.
 *
 * - `support.macro_placeholder_unknown`: the macro names a placeholder outside `SUPPORT_MACRO_PLACEHOLDERS`. Nothing is
 *   saved.
 * - `support.macro_placeholder_blank`: a reply still holds a placeholder (its value was blank for this request). Nothing
 *   is sent.
 * - `support.shortcode_taken`: another macro already has this shortcode. Nothing is saved.
 * - `support.shortcode_rule_unset`: the shortcode's minimum length is blank. Every save refuses until it is set.
 * - `support.shortcode_too_short`: the shortcode is shorter than the desk's minimum. Nothing is saved.
 * - `support.macro_revision_stale`: the macro or signature moved on since the writer read it. Nothing is saved.
 * - `support.macro_not_found`: no macro has this id.
 * - `support.not_lead`: only a lead writes macros. Any agent reads and applies them.
 */
import { z } from 'zod';

export const SUPPORT_MACRO_ERROR_CODES = [
  'support.macro_placeholder_unknown',
  'support.macro_placeholder_blank',
  'support.shortcode_taken',
  'support.shortcode_rule_unset',
  'support.shortcode_too_short',
  'support.macro_revision_stale',
  'support.macro_not_found',
  'support.not_lead',
] as const;
export type SupportMacroErrorCode = (typeof SUPPORT_MACRO_ERROR_CODES)[number];

/** The closed list a macro may name: none reads money or account data. */
export const SUPPORT_MACRO_PLACEHOLDERS = ['requester.name', 'ticket.id', 'agent.name'] as const;
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

/** The known placeholders a text still holds, unfilled. A reply holding any of them is refused. */
export function supportMacroUnfilled(text: string): SupportMacroPlaceholder[] {
  return supportMacroPlaceholders(text).filter((name): name is SupportMacroPlaceholder =>
    (SUPPORT_MACRO_PLACEHOLDERS as readonly string[]).includes(name),
  );
}

/** The body with each placeholder whose value is known replaced by it. A blank or unknown one is left as written. */
export function fillSupportMacro(body: string, values: Readonly<Record<SupportMacroPlaceholder, string | null>>): string {
  return body.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return whole;
    const value = values[name as SupportMacroPlaceholder];
    return value === null || value.trim() === '' ? whole : value;
  });
}

export const SUPPORT_MACRO_BODY_MAX = 5_000;
export const SUPPORT_SIGNATURE_MAX = 500;
export const SUPPORT_SHORTCODE_MAX = 40;

const title = z.string().trim().min(1).max(80);
/** One word, so it can be typed after the expander. Its minimum length is the desk's setting, checked by svc-support. */
const shortcode = z.string().trim().min(1).max(SUPPORT_SHORTCODE_MAX).regex(/^\S+$/u);

export const supportMacroSchema = z.object({
  id: z.string().guid(),
  title,
  shortcode,
  /** Where the macro is filed in the desk's list; null when it is not in a folder. */
  folder: title.nullable(),
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
  title,
  shortcode,
  folder: title.nullable(),
  body: z.string().min(1).max(SUPPORT_MACRO_BODY_MAX),
  /** The revision the lead read: 0 to create. A moved revision refuses `support.macro_revision_stale`. */
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type SupportMacroSaveInput = z.infer<typeof supportMacroSaveInputSchema>;

export const supportMacroApplyInputSchema = z.object({ ticketId: z.string().guid(), macroId: z.string().guid() });

/** A macro filled for one request. Applying it writes nothing. `unfilled` names the placeholders left in `text`. */
export const supportMacroAppliedSchema = z.object({
  macroId: z.string().guid(),
  revision: z.number().int().positive(),
  text: z.string().min(1),
  unfilled: z.array(z.enum(SUPPORT_MACRO_PLACEHOLDERS)),
});
export type SupportMacroApplied = z.infer<typeof supportMacroAppliedSchema>;

/** The caller's own signature. `signature` is null until they set one; then nothing goes into their drafts. */
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
