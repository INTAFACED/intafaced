/**
 * Outreach public settings contract (SP-pages-02): the two owner-set values the public partner page reads from the
 * outreach desk, each a value or `null`, and the founder call that sets them.
 *
 * - `joinUrl`: where the invitation site (the join and partner enquiry forms) is served. The partner page links to its
 *   `/partner` form only when this is set; blank means the page says the form address is not set. Until a founder first
 *   sets either value (revision 0) a build-time address may stand in; after that, this value decides, and a cleared one
 *   withdraws the link.
 * - `partnerTerms`: programme terms as plain text, supplied by the founders and their lawyers. Blank means the page says
 *   no terms are published. This file holds no wording of its own.
 *
 * Browser safe: nothing here imports Node. The values are public by design and hold no customer data.
 *
 * Rules carried by the shapes below:
 * - A read never fails because a value is blank: it answers `null`.
 * - A write names the revision it read and a reason. Setting a value to `null` clears it.
 * - A malformed value is refused at write (`ops.public_setting_invalid`) and never stored.
 */
import { z } from 'zod';

export const OUTREACH_PUBLIC_ERROR_CODES = ['ops.public_setting_invalid', 'ops.public_settings_revision_stale'] as const;
export type OutreachPublicErrorCode = (typeof OUTREACH_PUBLIC_ERROR_CODES)[number];

export const OUTREACH_PUBLIC_SETTINGS = ['joinUrl', 'partnerTerms'] as const;
export type OutreachPublicSetting = (typeof OUTREACH_PUBLIC_SETTINGS)[number];

export const OUTREACH_JOIN_URL_MAX = 300;
export const OUTREACH_PARTNER_TERMS_MAX = 20_000;
export const OUTREACH_PUBLIC_REASON_MAX = 500;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// Control, private-use, unassigned and lone-surrogate characters, line separators and the bidi embeddings, overrides and
// isolates (which can reorder what a visitor reads) are refused. Line breaks and tabs are kept, and so are the joiners and
// direction marks that Arabic, Persian or emoji text needs.
const TERMS_FORBIDDEN = /[\p{Cc}\p{Co}\p{Cn}\p{Cs}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/**
 * Why a value cannot be stored, or `null` when it can. Judged after trimming. A join address is an origin only: https, or
 * http on a loopback host (a local stack), with no user, password, path, query or fragment.
 */
export function outreachPublicProblem(setting: OutreachPublicSetting, value: string): string | null {
  const text = value.trim();
  if (text === '') return 'empty';
  if (setting === 'partnerTerms') {
    if (text.length > OUTREACH_PARTNER_TERMS_MAX) return 'too_long';
    return TERMS_FORBIDDEN.test(text.replace(/[\r\n\t]/g, '')) ? 'not_text' : null;
  }
  if (text.length > OUTREACH_JOIN_URL_MAX) return 'too_long';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'not_an_origin';
  }
  if (url.username || url.password) return 'not_an_origin';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return 'not_https';
  return url.pathname === '/' && !url.search && !url.hash && !text.endsWith('?') && !text.endsWith('#') ? null : 'not_an_origin';
}

const value = z.string().min(1).nullable();

/** What a visitor may read. Each value is set or `null`; `revision` is 0 until a founder sets one. */
export const outreachPublicSettingsSchema = z
  .object({
    joinUrl: value,
    partnerTerms: value,
    revision: z.number().int().min(0),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type OutreachPublicSettings = z.infer<typeof outreachPublicSettingsSchema>;

// Trimmed before it is judged, so the parsed value is exactly the text that was judged and the service stores. A join
// address is stored as its origin (lower-case host, no default port, no trailing slash).
const settable = (setting: OutreachPublicSetting) =>
  z
    .string()
    .trim()
    .nullable()
    .refine((input) => input === null || outreachPublicProblem(setting, input) === null, { message: 'ops.public_setting_invalid' })
    .transform((input) => (input !== null && setting === 'joinUrl' ? new URL(input).origin : input));

/**
 * Set one or both values. A field left out is unchanged; `null` clears it. `expectedRevision` is the revision the founder
 * read, so the other founder's change is never overwritten without being seen.
 */
export const outreachPublicSettingsSetInputSchema = z
  .object({
    joinUrl: settable('joinUrl').optional(),
    partnerTerms: settable('partnerTerms').optional(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    reason: z.string().trim().min(1).max(OUTREACH_PUBLIC_REASON_MAX),
  })
  .strict()
  .refine((input) => OUTREACH_PUBLIC_SETTINGS.some((setting) => input[setting] !== undefined), {
    message: 'ops.public_setting_invalid',
  });
export type OutreachPublicSettingsSetInput = z.infer<typeof outreachPublicSettingsSetInputSchema>;

/**
 * The key a change is logged under. The revision it moves from makes a lost reply a replay, never a second change; on a key
 * hit the service compares the change itself: the same change replays, a different one is `ops.public_settings_revision_stale`.
 */
export function outreachPublicSetKey(expectedRevision: number): string {
  return `ops.public_settings:r${expectedRevision}`;
}
