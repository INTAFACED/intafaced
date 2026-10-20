/**
 * Support contact channels contract (SP-help-centre-01): the owner-set support email, phone and chat hours, each a value
 * or `null`, and the operator call that sets them.
 *
 * Browser safe: nothing here imports Node. A blank channel is `null` and the screen says "not set"; there is no built-in
 * address, number or hour to fall back to. The values are public by design and hold no customer data.
 *
 * Rules carried by the shapes below:
 * - A read never fails because a channel is blank: it answers `null`.
 * - A write names the revision it read. Setting a channel to `null` clears it.
 * - A malformed value is refused at write (`support.contact_setting_invalid`) and never stored.
 */
import { z } from 'zod';

export const SUPPORT_CONTACT_ERROR_CODES = ['support.contact_setting_invalid', 'support.contact_revision_stale'] as const;
export type SupportContactErrorCode = (typeof SUPPORT_CONTACT_ERROR_CODES)[number];

export const SUPPORT_CONTACT_SETTINGS = ['email', 'phone', 'chatHours'] as const;
export type SupportContactSetting = (typeof SUPPORT_CONTACT_SETTINGS)[number];

export const SUPPORT_CONTACT_EMAIL_MAX = 254;
export const SUPPORT_CONTACT_PHONE_MAX = 32;
export const SUPPORT_CONTACT_HOURS_MAX = 120;
export const SUPPORT_CONTACT_REASON_MAX = 500;

// A positive list, so nothing that can carry a `mailto:` parameter, a second recipient, a fragment, a control or a
// direction-override character gets in. ASCII only; an address outside it is refused rather than guessed at.
const EMAIL_LOCAL = /^[A-Za-z0-9]+(?:[._+-][A-Za-z0-9]+)*$/;
const EMAIL_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
// A dial string: digits and the usual separators. An extension ("ext 12") is not part of it.
const PHONE = /^\+?[0-9 ()\-.]+$/;
// Control, format, line-separator and angle-bracket characters are not text a visitor should be shown as hours.
const HOURS_FORBIDDEN = /[\p{C}\u2028\u2029<>]/u;

function emailProblem(text: string): string | null {
  if (text.length > SUPPORT_CONTACT_EMAIL_MAX) return 'too_long';
  const at = text.indexOf('@');
  if (at < 1 || at !== text.lastIndexOf('@')) return 'not_an_address';
  const labels = text.slice(at + 1).split('.');
  const ok =
    EMAIL_LOCAL.test(text.slice(0, at)) &&
    labels.length >= 2 &&
    labels.every((label) => label.length <= 63 && EMAIL_LABEL.test(label)) &&
    /^[A-Za-z]{2,}$/.test(labels[labels.length - 1] ?? '');
  return ok ? null : 'not_an_address';
}

/** Why a value cannot be stored, or `null` when it can. The value is judged after trimming; the service stores the trimmed text. */
export function supportContactProblem(setting: SupportContactSetting, value: string): string | null {
  const text = value.trim();
  if (text === '') return 'empty';
  switch (setting) {
    case 'email':
      return emailProblem(text);
    case 'phone': {
      if (text.length > SUPPORT_CONTACT_PHONE_MAX) return 'too_long';
      if (!PHONE.test(text)) return 'not_a_number';
      return text.replace(/\D/g, '').length >= 5 ? null : 'not_a_number';
    }
    case 'chatHours':
      if (text.length > SUPPORT_CONTACT_HOURS_MAX) return 'too_long';
      return HOURS_FORBIDDEN.test(text) ? 'not_text' : null;
  }
}

const channel = z.string().min(1).nullable();

/** What a visitor may read. Every channel is a value or `null`; `revision` is 0 until the owner sets one. */
export const supportContactChannelsSchema = z
  .object({
    email: channel,
    phone: channel,
    chatHours: channel,
    revision: z.number().int().min(0),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type SupportContactChannels = z.infer<typeof supportContactChannelsSchema>;

// Trimmed before it is judged, so the parsed value is exactly the text that was judged and the service stores.
const settable = (setting: SupportContactSetting) =>
  z
    .string()
    .trim()
    .nullable()
    .refine((value) => value === null || supportContactProblem(setting, value) === null, { message: 'support.contact_setting_invalid' });

/**
 * Set one or more channels. A field left out is unchanged; `null` clears it. `expectedRevision` is the revision the
 * operator read, so a second operator's change is never overwritten without being seen.
 */
export const supportContactSetInputSchema = z
  .object({
    email: settable('email').optional(),
    phone: settable('phone').optional(),
    chatHours: settable('chatHours').optional(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    reason: z.string().trim().min(1).max(SUPPORT_CONTACT_REASON_MAX),
  })
  .strict()
  .refine((input) => SUPPORT_CONTACT_SETTINGS.some((setting) => input[setting] !== undefined), {
    message: 'support.contact_setting_invalid',
  });
export type SupportContactSetInput = z.infer<typeof supportContactSetInputSchema>;

/**
 * The key a change is logged under. The revision it moves from makes a lost reply a replay, never a second change. Two
 * operators who read the same revision share this key, so the service compares the change itself on a key hit: the same
 * change replays, a different one is `support.contact_revision_stale`.
 */
export function supportContactSetKey(expectedRevision: number): string {
  return `support.contact:r${expectedRevision}`;
}
