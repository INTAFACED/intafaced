/**
 * Help centre settings (SP-help-centre-03): name, address, languages, setup mode and the publish switch.
 *
 * Browser safe: nothing here imports Node. A field the owner has not set is `null`, never a built-in name, language or
 * "on". The offered language list and the default language are blank owner values. `support.languages_unset` is the
 * refusal when a reader asks for a language and none are offered.
 *
 * The language-list length is a wire bound, not an owner cap: the owner value is the list itself, and an unset list is
 * `null`. Theme is the owner's choice of which product palette the public help centre opens in (`system`, `light` or
 * `dark`); it is blank until the owner sets it and never a template editor: the look stays the product tokens.
 */
import { z } from 'zod';

export const SUPPORT_HELP_CENTRE_SETTING_INVALID = 'support.help_centre_setting_invalid';
export const SUPPORT_HELP_CENTRE_REVISION_STALE = 'support.help_centre_revision_stale';
export const SUPPORT_LANGUAGES_UNSET = 'support.languages_unset';
export const SUPPORT_HELP_CENTRE_LIST_LIMIT_UNSET = 'support.help_centre_list_limit_unset';
/** The owner switched the help centre off: the public answer doors refuse a reader who is not support staff. */
export const SUPPORT_HELP_CENTRE_OFF = 'support.help_centre_off';
/** A translation request id came back with a different state from the one it first recorded. */
export const SUPPORT_HELP_CENTRE_IDEMPOTENCY_CONFLICT = 'support.help_centre_idempotency_conflict';

export const SUPPORT_HELP_CENTRE_ERROR_CODES = [
  SUPPORT_HELP_CENTRE_SETTING_INVALID,
  SUPPORT_HELP_CENTRE_REVISION_STALE,
  SUPPORT_LANGUAGES_UNSET,
  SUPPORT_HELP_CENTRE_LIST_LIMIT_UNSET,
  SUPPORT_HELP_CENTRE_OFF,
  SUPPORT_HELP_CENTRE_IDEMPOTENCY_CONFLICT,
] as const;
export type SupportHelpCentreErrorCode = (typeof SUPPORT_HELP_CENTRE_ERROR_CODES)[number];

export const SUPPORT_HELP_CENTRE_NAME_MAX = 80;
export const SUPPORT_HELP_CENTRE_ADDRESS_MAX = 200;
export const SUPPORT_HELP_CENTRE_REASON_MAX = 500;
/** Wire bound on how many language tags one write may carry. Not an owner cap. */
export const SUPPORT_HELP_CENTRE_LANGUAGE_WIRE_MAX = 24;
export const SUPPORT_HELP_CENTRE_LIST_LIMIT_MAX = 500;

export const SUPPORT_HELP_CENTRE_SETUP_MODES = ['setup', 'live'] as const;
export type SupportHelpCentreSetupMode = (typeof SUPPORT_HELP_CENTRE_SETUP_MODES)[number];

/** The product palette the public help centre opens in. A blank theme is `null`, never a built-in choice. */
export const SUPPORT_HELP_CENTRE_THEMES = ['system', 'light', 'dark'] as const;
export type SupportHelpCentreTheme = (typeof SUPPORT_HELP_CENTRE_THEMES)[number];

export const SUPPORT_HELP_CENTRE_TRANSLATION_STATES = ['translated', 'missing'] as const;
export type SupportHelpCentreTranslationState = (typeof SUPPORT_HELP_CENTRE_TRANSLATION_STATES)[number];

const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/;
const NAME_FORBIDDEN = /[\p{C}\u2028\u2029<>]/u;

/** Why a language tag cannot be stored, or `null` when it can. */
export function supportHelpCentreLanguageProblem(value: string): string | null {
  const text = value.trim();
  if (text === '') return 'empty';
  return LANGUAGE.test(text) ? null : 'not_a_language';
}

/** Why a help-centre name cannot be stored, or `null` when it can. */
export function supportHelpCentreNameProblem(value: string): string | null {
  const text = value.trim();
  if (text === '') return 'empty';
  if (text.length > SUPPORT_HELP_CENTRE_NAME_MAX) return 'too_long';
  return NAME_FORBIDDEN.test(text) ? 'not_text' : null;
}

/** Why an address cannot be stored, or `null` when it can. Only an https URL with a host is an address. */
export function supportHelpCentreAddressProblem(value: string): string | null {
  const text = value.trim();
  if (text === '') return 'empty';
  if (text.length > SUPPORT_HELP_CENTRE_ADDRESS_MAX) return 'too_long';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'not_an_address';
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') return 'not_an_address';
  return null;
}

const languageTag = z
  .string()
  .trim()
  .refine((value) => supportHelpCentreLanguageProblem(value) === null, { message: SUPPORT_HELP_CENTRE_SETTING_INVALID });

const nameField = z
  .string()
  .trim()
  .nullable()
  .refine((value) => value === null || supportHelpCentreNameProblem(value) === null, { message: SUPPORT_HELP_CENTRE_SETTING_INVALID });

const addressField = z
  .string()
  .trim()
  .nullable()
  .refine((value) => value === null || supportHelpCentreAddressProblem(value) === null, {
    message: SUPPORT_HELP_CENTRE_SETTING_INVALID,
  });

const languagesField = z
  .array(languageTag)
  .max(SUPPORT_HELP_CENTRE_LANGUAGE_WIRE_MAX)
  .nullable()
  .refine((value) => value === null || (value.length >= 1 && new Set(value).size === value.length), {
    message: SUPPORT_HELP_CENTRE_SETTING_INVALID,
  });

/** What a visitor may read. Every owner field is a value or `null`; `revision` is 0 until the owner sets one. */
export const supportHelpCentreSchema = z
  .object({
    name: z.string().min(1).nullable(),
    address: z.string().min(1).nullable(),
    defaultLanguage: z.string().min(1).nullable(),
    languages: z.array(z.string().min(1)).nullable(),
    setupMode: z.enum(SUPPORT_HELP_CENTRE_SETUP_MODES).nullable(),
    theme: z.enum(SUPPORT_HELP_CENTRE_THEMES).nullable(),
    published: z.boolean().nullable(),
    revision: z.number().int().min(0),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type SupportHelpCentre = z.infer<typeof supportHelpCentreSchema>;

/**
 * Set one or more fields. A field left out is unchanged; `null` clears it back to unset. `expectedRevision` is the
 * revision the operator read.
 */
export const supportHelpCentreSetInputSchema = z
  .object({
    name: nameField.optional(),
    address: addressField.optional(),
    defaultLanguage: languageTag.nullable().optional(),
    languages: languagesField.optional(),
    setupMode: z.enum(SUPPORT_HELP_CENTRE_SETUP_MODES).nullable().optional(),
    theme: z.enum(SUPPORT_HELP_CENTRE_THEMES).nullable().optional(),
    published: z.boolean().nullable().optional(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    reason: z.string().trim().min(1).max(SUPPORT_HELP_CENTRE_REASON_MAX),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined ||
      input.address !== undefined ||
      input.defaultLanguage !== undefined ||
      input.languages !== undefined ||
      input.setupMode !== undefined ||
      input.theme !== undefined ||
      input.published !== undefined,
    { message: SUPPORT_HELP_CENTRE_SETTING_INVALID },
  );
export type SupportHelpCentreSetInput = z.infer<typeof supportHelpCentreSetInputSchema>;

export const supportHelpCentreLanguageInputSchema = z
  .object({
    language: z.string().trim().min(1).max(32),
    articleId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    version: z.number().int().positive().optional(),
  })
  .strict()
  .refine((input) => (input.articleId === undefined) === (input.version === undefined), {
    message: SUPPORT_HELP_CENTRE_SETTING_INVALID,
  });
export type SupportHelpCentreLanguageInput = z.infer<typeof supportHelpCentreLanguageInputSchema>;

export const supportHelpCentreLanguageSchema = z
  .object({
    language: z.string().min(1),
    defaultLanguage: z.string().min(1).nullable(),
    languages: z.array(z.string().min(1)).min(1),
    published: z.boolean().nullable(),
    setupMode: z.enum(SUPPORT_HELP_CENTRE_SETUP_MODES).nullable(),
    name: z.string().min(1).nullable(),
    address: z.string().min(1).nullable(),
    /** Null when the reader did not name an article. `missing` is a measured gap, not a guess. */
    translation: z
      .object({
        articleId: z.string().min(1),
        version: z.number().int().positive(),
        state: z.enum(SUPPORT_HELP_CENTRE_TRANSLATION_STATES),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SupportHelpCentreLanguage = z.infer<typeof supportHelpCentreLanguageSchema>;

export const supportHelpCentreTranslationSetInputSchema = z
  .object({
    articleId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.number().int().positive(),
    language: languageTag,
    state: z.enum(SUPPORT_HELP_CENTRE_TRANSLATION_STATES),
    clientRequestId: z
      .string()
      .trim()
      .min(8)
      .max(200)
      .refine((value) => !/[\p{C}]/u.test(value), { message: SUPPORT_HELP_CENTRE_SETTING_INVALID }),
    reason: z.string().trim().min(1).max(SUPPORT_HELP_CENTRE_REASON_MAX),
  })
  .strict();
export type SupportHelpCentreTranslationSetInput = z.infer<typeof supportHelpCentreTranslationSetInputSchema>;

export const supportHelpCentreTranslationSchema = z
  .object({
    articleId: z.string().min(1),
    version: z.number().int().positive(),
    language: z.string().min(1),
    state: z.enum(SUPPORT_HELP_CENTRE_TRANSLATION_STATES),
  })
  .strict();
export type SupportHelpCentreTranslation = z.infer<typeof supportHelpCentreTranslationSchema>;

export const supportHelpCentreTranslationListInputSchema = z
  .object({
    /**
     * Page size. Optional so an omit reaches the named refusal `support.help_centre_list_limit_unset` instead of a
     * schema "Required". Blank is not 100.
     */
    limit: z.number().int().positive().max(SUPPORT_HELP_CENTRE_LIST_LIMIT_MAX).optional(),
  })
  .strict();

/**
 * `languages` and `total` are null while the owner has not offered any language: that is "not set", not zero gaps.
 * When languages are set, `total` is the measured count of article-version × language rows and `rows` is the page.
 */
export const supportHelpCentreTranslationListSchema = z
  .object({
    languages: z.array(z.string().min(1)).min(1).nullable(),
    total: z.number().int().min(0).nullable(),
    rows: z.array(supportHelpCentreTranslationSchema),
  })
  .strict();
export type SupportHelpCentreTranslationList = z.infer<typeof supportHelpCentreTranslationListSchema>;

export const supportHelpCentreChangesInputSchema = z
  .object({
    /**
     * Page size. Optional so an omit reaches the named refusal `support.help_centre_list_limit_unset` instead of a
     * schema "Required". Blank is not 100.
     */
    limit: z.number().int().positive().max(SUPPORT_HELP_CENTRE_LIST_LIMIT_MAX).optional(),
  })
  .strict();
export type SupportHelpCentreChangesInput = z.infer<typeof supportHelpCentreChangesInputSchema>;

/** The settings fields a change can touch, in the order the change log names them. */
export const SUPPORT_HELP_CENTRE_FIELDS = ['name', 'address', 'defaultLanguage', 'languages', 'setupMode', 'theme', 'published'] as const;
export type SupportHelpCentreField = (typeof SUPPORT_HELP_CENTRE_FIELDS)[number];

/**
 * One row of the settings change log (`helpCentreChanges`, `support:ops`): the revision it made, who, why, when, the
 * record before and after, and the fields that differ. Append-only; newest first on the wire.
 */
export const supportHelpCentreChangeSchema = z
  .object({
    revision: z.number().int().positive(),
    by: z.string().min(1),
    reason: z.string().min(1),
    at: z.string().datetime(),
    changed: z.array(z.enum(SUPPORT_HELP_CENTRE_FIELDS)),
    before: supportHelpCentreSchema,
    after: supportHelpCentreSchema,
  })
  .strict();
export type SupportHelpCentreChange = z.infer<typeof supportHelpCentreChangeSchema>;
export const supportHelpCentreChangeListSchema = z.array(supportHelpCentreChangeSchema);

/** The key a settings change is logged under. The revision it moves from makes a lost reply a replay, never a second change. */
export function supportHelpCentreSetKey(expectedRevision: number): string {
  return `support.helpCentre:r${expectedRevision}`;
}

/** The key one translation write is logged under. The caller supplies the request id; the service never mints one. */
export function supportHelpCentreTranslationKey(input: {
  articleId: string;
  version: number;
  language: string;
  clientRequestId: string;
}): string {
  return `support.helpCentre.translation:${input.articleId}:v${input.version}:${input.language}:${input.clientRequestId}`;
}
