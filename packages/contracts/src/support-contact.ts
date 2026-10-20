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

const EMAIL = /^[^\s@<>"'`,;:()[\]\\]+@[^\s@<>"'`,;:()[\]\\]+\.[^\s@<>"'`,;:()[\]\\]+$/;
const PHONE = /^\+?[0-9 ()\-.]+$/;
const HOURS_FORBIDDEN = /[\u0000-\u001f\u007f<>]/;

/** Why a value cannot be stored, or `null` when it can. The value is judged after trimming; the service stores the trimmed text. */
export function supportContactProblem(setting: SupportContactSetting, value: string): string | null {
  const text = value.trim();
  if (text === '') return 'empty';
  switch (setting) {
    case 'email':
      if (text.length > SUPPORT_CONTACT_EMAIL_MAX) return 'too_long';
      return EMAIL.test(text) ? null : 'not_an_address';
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

const settable = (setting: SupportContactSetting) =>
  z
    .string()
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

/** The key a change is logged under. The revision it moves from makes a lost reply a replay, never a second change. */
export function supportContactSetKey(expectedRevision: number): string {
  return `support.contact:r${expectedRevision}`;
}
