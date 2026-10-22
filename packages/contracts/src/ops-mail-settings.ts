import { z } from 'zod';

/**
 * Mailbox and calendar sync settings (OPS-outreach-01), owned by svc-ops.
 *
 * PARKED ROOM. No allowlist code covers a mailbox or calendar account (`vendor.email` is transactional send only), so
 * the connect action and the sync worker refuse until the owner decides the provider. The SETTINGS model is real and is
 * stored without a provider: a connection record per mailbox slot, a sharing level, contact-creation rules and a sync
 * scope. Saved settings without a connection are a draft and the room says the sync is off.
 *
 * Mailbox credentials are write-only: no output schema here carries one.
 */

export const OPS_MAIL_ALIAS_REFUSED = 'ops.mail.alias_refused' as const;
export const OPS_MAIL_PROVIDER_UNSET = 'ops.mail.provider_unset' as const;
export const OPS_MAIL_SCOPE_INVALID = 'ops.mail.scope_invalid' as const;
/** Company linking by domain is on but the suppressed (free-mail) domain list is blank: refused, never "link every domain". */
export const OPS_MAIL_FREE_MAIL_DOMAINS_UNSET = 'ops.mail.free_mail_domains_unset' as const;
/** The save's `expectedRevision` is not the stored revision (another operator or tab saved first). */
export const OPS_MAIL_REVISION_CONFLICT = 'ops.mail.revision_conflict' as const;
export type OpsMailRefusal =
  | typeof OPS_MAIL_ALIAS_REFUSED
  | typeof OPS_MAIL_PROVIDER_UNSET
  | typeof OPS_MAIL_SCOPE_INVALID
  | typeof OPS_MAIL_FREE_MAIL_DOMAINS_UNSET
  | typeof OPS_MAIL_REVISION_CONFLICT;

/** NotConnected for the Connect press: the code proposed by the spec, and its copy. */
export const OPS_MAIL_NOT_CONNECTED_CODE = 'owner.decision' as const;
export const OPS_MAIL_NOT_CONNECTED_COPY =
  'Connecting a mailbox needs an owner decision on the mail provider. It is switched off in this build.' as const;

export const MAIL_SIGN_IN_METHODS = ['oauth', 'incoming_mail'] as const;
export const MAIL_INCOMING_PROTOCOLS = ['imap', 'pop3'] as const;
export const MAIL_OUTGOING_PROTOCOLS = ['smtp'] as const;
export const CALENDAR_PROTOCOLS = ['caldav', 'none'] as const;

/** Sharing of synced mail. A blank setting is stored as `metadata_only` (spec: blank shares metadata only). */
export const MAIL_SHARING_LEVELS = ['metadata_only', 'subject_and_metadata', 'full_content'] as const;
export const mailSharingLevelSchema = z.enum(MAIL_SHARING_LEVELS);
export type MailSharingLevel = z.infer<typeof mailSharingLevelSchema>;
export const DEFAULT_MAIL_SHARING_LEVEL: MailSharingLevel = 'metadata_only';

/** Sharing of synced calendar events. Blank is the narrower `date_and_participants`. */
export const CALENDAR_SHARING_LEVELS = ['date_and_participants', 'everything'] as const;
export const calendarSharingLevelSchema = z.enum(CALENDAR_SHARING_LEVELS);
export type CalendarSharingLevel = z.infer<typeof calendarSharingLevelSchema>;
export const DEFAULT_CALENDAR_SHARING_LEVEL: CalendarSharingLevel = 'date_and_participants';

export const MAIL_CONTACT_CREATION = ['sent_and_received', 'sent_only', 'never'] as const;
export const mailContactCreationSchema = z.enum(MAIL_CONTACT_CREATION);
export type MailContactCreation = z.infer<typeof mailContactCreationSchema>;

const emailDomain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Expected a domain name');

/**
 * Company linking by email domain. `off` links nothing. `by_domain` links a contact to the company of its email domain,
 * except the suppressed (free-mail) domains, which never create or link a company. The list is the owner's; an empty list
 * refuses with `ops.mail.free_mail_domains_unset`.
 */
export const mailCompanyLinkingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }).strict(),
  z
    .object({
      mode: z.literal('by_domain'),
      suppressedDomains: z
        .array(emailDomain)
        .max(5_000)
        .superRefine((list, ctx) => {
          if (list.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: OPS_MAIL_FREE_MAIL_DOMAINS_UNSET });
          if (new Set(list).size !== list.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate domains' });
        }),
    })
    .strict(),
]);
export type MailCompanyLinking = z.infer<typeof mailCompanyLinkingSchema>;

/** The domain a contact's address links to, or null when linking is off or the domain is suppressed. */
export function companyLinkDomain(address: string, linking: MailCompanyLinking): string | null {
  if (linking.mode === 'off') return null;
  const domain = (address.split('@')[1] ?? '').trim().toLowerCase();
  if (!domain || linking.suppressedDomains.includes(domain)) return null;
  return domain;
}

export const MAIL_EXCLUSIONS = ['spam', 'trash', 'internal_mail', 'group_lists', 'private_events'] as const;
export const mailExclusionSchema = z.enum(MAIL_EXCLUSIONS);

const mailbox = z.string().trim().toLowerCase().max(254).email();

/**
 * Only true mailboxes. A plus-addressed (sub-addressed) address is an alias of another mailbox and is refused with
 * `ops.mail.alias_refused`; the provider-side alias check runs in the connection test once a provider exists.
 */
export function isAliasAddress(address: string): boolean {
  const local = address.split('@')[0] ?? '';
  return local.includes('+');
}

export const mailboxAddressSchema = mailbox.refine((a) => !isAliasAddress(a), { message: OPS_MAIL_ALIAS_REFUSED });

export const mailConnectionSettingsSchema = z
  .object({
    address: mailboxAddressSchema,
    signInMethod: z.enum(MAIL_SIGN_IN_METHODS),
    incomingProtocol: z.enum(MAIL_INCOMING_PROTOCOLS),
    outgoingProtocol: z.enum(MAIL_OUTGOING_PROTOCOLS),
    calendarProtocol: z.enum(CALENDAR_PROTOCOLS),
  })
  .strict();
export type MailConnectionSettings = z.infer<typeof mailConnectionSettingsSchema>;

/** Folder names are the mailbox's own; inbox and sent are always named explicitly. */
const folderName = z.string().trim().min(1).max(128);

export const mailSyncScopeSchema = z
  .object({
    inbox: z.boolean(),
    sent: z.boolean(),
    customFolders: z.array(folderName).max(200),
    exclusions: z.array(mailExclusionSchema).max(MAIL_EXCLUSIONS.length),
    /** Minutes between sync runs. Blank refuses: no cadence is invented. */
    cadenceMinutes: z.number().int().min(1).max(10_080),
  })
  .strict()
  .superRefine((scope, ctx) => {
    if (!scope.inbox && !scope.sent && scope.customFolders.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: OPS_MAIL_SCOPE_INVALID, path: ['inbox'] });
    }
    if (new Set(scope.customFolders.map((f) => f.toLowerCase())).size !== scope.customFolders.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: OPS_MAIL_SCOPE_INVALID, path: ['customFolders'] });
    }
    if (new Set(scope.exclusions).size !== scope.exclusions.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: OPS_MAIL_SCOPE_INVALID, path: ['exclusions'] });
    }
  });
export type MailSyncScope = z.infer<typeof mailSyncScopeSchema>;

/** The save input. Sharing levels may be omitted; svc-ops stores the documented narrow default and the form says so. */
export const mailSettingsSaveInputSchema = z
  .object({
    slotId: z.string().uuid(),
    /** Revision the operator read; null only for the first save of a slot. A mismatch refuses `ops.mail.revision_conflict`. */
    expectedRevision: z.number().int().positive().safe().nullable(),
    connection: mailConnectionSettingsSchema,
    mailSharing: mailSharingLevelSchema.optional(),
    calendarSharing: calendarSharingLevelSchema.optional(),
    contactCreation: mailContactCreationSchema,
    companyLinking: mailCompanyLinkingSchema,
    scope: mailSyncScopeSchema,
  })
  .strict();
export type MailSettingsSaveInput = z.infer<typeof mailSettingsSaveInputSchema>;

/** What the room reads back. No credential, ever. `syncState` is `off_draft` until a provider exists. */
export const mailSettingsSchema = z
  .object({
    slotId: z.string().uuid(),
    ownerOperatorId: z.string().min(1).max(128),
    connection: mailConnectionSettingsSchema,
    mailSharing: mailSharingLevelSchema,
    mailSharingDefaulted: z.boolean(),
    calendarSharing: calendarSharingLevelSchema,
    calendarSharingDefaulted: z.boolean(),
    contactCreation: mailContactCreationSchema,
    companyLinking: mailCompanyLinkingSchema,
    scope: mailSyncScopeSchema,
    revision: z.number().int().positive().safe(),
    syncState: z.enum(['off_draft', 'off_provider_unset']),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MailSettings = z.infer<typeof mailSettingsSchema>;

/** Resolve the stored sharing levels for a save, recording whether each was defaulted. */
export function resolveMailSharing(input: Pick<MailSettingsSaveInput, 'mailSharing' | 'calendarSharing'>): {
  mailSharing: MailSharingLevel;
  mailSharingDefaulted: boolean;
  calendarSharing: CalendarSharingLevel;
  calendarSharingDefaulted: boolean;
} {
  return {
    mailSharing: input.mailSharing ?? DEFAULT_MAIL_SHARING_LEVEL,
    mailSharingDefaulted: input.mailSharing === undefined,
    calendarSharing: input.calendarSharing ?? DEFAULT_CALENDAR_SHARING_LEVEL,
    calendarSharingDefaulted: input.calendarSharing === undefined,
  };
}

/** The typed refusal a save maps to, from a zod failure. */
export function mailSettingsRefusal(error: z.ZodError): OpsMailRefusal | null {
  const messages = error.issues.map((i) => i.message);
  if (messages.includes(OPS_MAIL_ALIAS_REFUSED)) return OPS_MAIL_ALIAS_REFUSED;
  if (messages.includes(OPS_MAIL_SCOPE_INVALID)) return OPS_MAIL_SCOPE_INVALID;
  if (messages.includes(OPS_MAIL_FREE_MAIL_DOMAINS_UNSET)) return OPS_MAIL_FREE_MAIL_DOMAINS_UNSET;
  return null;
}
