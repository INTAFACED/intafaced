/**
 * Support ticket attachments contract (SP-tickets-02): the owner-set limits, the state of each piece an attach needs,
 * the scan state of a stored file, and the download an owner or an operator may take.
 *
 * Browser safe: nothing here imports Node. A blank limit is `null` and the screen says "not set"; there is no built-in
 * size, count or type list. The transport bound on a request body is not a product limit and is never shown as one.
 *
 * Rules carried by the shapes below:
 * - A read never fails because a limit is blank: it answers `null` and names the first missing piece in `missing`.
 * - A write names the revision it read. Setting a limit to `null` clears it.
 * - A file is served only when its scan state is `clean`. `scanning` and `blocked` are never served.
 * - A download carries a fixed, safe content type chosen by the service, never the uploader's, and is never inline.
 */
import { z } from 'zod';

export const SUPPORT_ATTACHMENT_ERROR_CODES = [
  'support.attachments_unconfigured',
  'support.attachment_settings_invalid',
  'support.attachment_revision_stale',
  'support.attachment_count_unset',
  'support.attachment_count_reached',
  'support.attachment_too_large',
  'support.attachment_type_refused',
  'support.attachment_scan_unknown',
  'support.attachment_scan_refused',
] as const;
export type SupportAttachmentErrorCode = (typeof SUPPORT_ATTACHMENT_ERROR_CODES)[number];

/** The limits the owner sets. The store and the scanner are deployment configuration and are not settable here. */
export const SUPPORT_ATTACHMENT_SETTINGS = ['maxBytes', 'allowedTypes', 'maxCount'] as const;
export type SupportAttachmentSetting = (typeof SUPPORT_ATTACHMENT_SETTINGS)[number];

/** Setting keys, in the order an attach needs them. These are the names a refusal gives for what is missing. */
export const SUPPORT_ATTACHMENT_KEYS = [
  'support.attachment_store',
  'support.malware_scanner',
  'support.attachment_max_bytes',
  'support.attachment_allowed_types',
  'support.attachment_max_count',
] as const;
export type SupportAttachmentKey = (typeof SUPPORT_ATTACHMENT_KEYS)[number];

export const SUPPORT_ATTACHMENT_REASON_MAX = 500;
// Schema sanity bounds only: they keep an integer a safe integer. They are not product limits and nothing defaults to them.
const INT_MAX = 2_147_483_646;
export const SUPPORT_ATTACHMENT_TYPES_MAX = 50;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** The one content type every download is served with, whatever the uploader sent. */
export const SUPPORT_ATTACHMENT_DOWNLOAD_TYPE = 'application/octet-stream' as const;

/** Why a media type cannot be on the list, or `null` when it can. A wildcard, a parameter and an uppercase letter are refused. */
export function supportAttachmentTypeProblem(value: string): string | null {
  return MEDIA_TYPE.test(value) ? null : 'not_a_media_type';
}

const mediaType = z.string().refine((value) => supportAttachmentTypeProblem(value) === null, {
  message: 'support.attachment_settings_invalid',
});

const positiveInt = z.number().int().min(1).max(INT_MAX);

const typeList = z
  .array(mediaType)
  .min(1)
  .max(SUPPORT_ATTACHMENT_TYPES_MAX)
  .refine((list) => new Set(list).size === list.length, { message: 'support.attachment_settings_invalid' });

/** What a signed-in customer or an operator may read. A blank limit is `null`; `revision` is 0 until the owner sets one. */
export const supportAttachmentLimitsSchema = z
  .object({
    maxBytes: positiveInt.nullable(),
    allowedTypes: typeList.nullable(),
    maxCount: positiveInt.nullable(),
    /** The first piece an attach is missing, in the order it needs them, or `null` when every piece is set. */
    missing: z.enum(SUPPORT_ATTACHMENT_KEYS).nullable(),
    revision: z.number().int().min(0),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type SupportAttachmentLimits = z.infer<typeof supportAttachmentLimitsSchema>;

/**
 * Set one or more limits. A field left out is unchanged; `null` clears it. `expectedRevision` is the revision the
 * operator read, so a second operator's change is never overwritten without being seen.
 */
export const supportAttachmentSettingsSetInputSchema = z
  .object({
    maxBytes: positiveInt.nullable().optional(),
    allowedTypes: typeList.nullable().optional(),
    maxCount: positiveInt.nullable().optional(),
    expectedRevision: z.number().int().min(0).max(INT_MAX),
    reason: z.string().trim().min(1).max(SUPPORT_ATTACHMENT_REASON_MAX),
  })
  .strict()
  .refine((input) => SUPPORT_ATTACHMENT_SETTINGS.some((setting) => input[setting] !== undefined), {
    message: 'support.attachment_settings_invalid',
  });
export type SupportAttachmentSettingsSetInput = z.infer<typeof supportAttachmentSettingsSetInputSchema>;

/** The key a limits change is logged under; the same replay-or-stale rule as the contact channels. */
export function supportAttachmentSetKey(expectedRevision: number): string {
  return `support.attachment_settings:r${expectedRevision}`;
}

/** One piece an attach needs and whether it is set. Deployment pieces carry no value, only whether they are present. */
export const supportAttachmentPieceSchema = z.object({ key: z.enum(SUPPORT_ATTACHMENT_KEYS), set: z.boolean() }).strict();
export type SupportAttachmentPiece = z.infer<typeof supportAttachmentPieceSchema>;

/** Operator view of the five pieces, in the order an attach needs them. */
export const supportAttachmentStatusSchema = z
  .object({ pieces: z.array(supportAttachmentPieceSchema).length(SUPPORT_ATTACHMENT_KEYS.length), limits: supportAttachmentLimitsSchema })
  .strict();
export type SupportAttachmentStatus = z.infer<typeof supportAttachmentStatusSchema>;

export const SUPPORT_ATTACHMENT_SCAN_STATES = ['scanning', 'clean', 'blocked'] as const;
export const supportAttachmentScanStateSchema = z.enum(SUPPORT_ATTACHMENT_SCAN_STATES);
export type SupportAttachmentScanState = z.infer<typeof supportAttachmentScanStateSchema>;

/** One stored file's metadata. The store key is internal and is not part of the wire. */
export const supportAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    ticketId: z.string().uuid(),
    ownerId: z.string().uuid(),
    contentType: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    scanState: supportAttachmentScanStateSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type SupportAttachment = z.infer<typeof supportAttachmentSchema>;

/** What a download answers: the bytes as base64, a fixed content type, and always a download. */
export const supportAttachmentDownloadSchema = z
  .object({
    id: z.string().uuid(),
    contentType: z.literal(SUPPORT_ATTACHMENT_DOWNLOAD_TYPE),
    disposition: z.literal('attachment'),
    byteLength: z.number().int().nonnegative(),
    bodyBase64: z.string(),
  })
  .strict();
export type SupportAttachmentDownload = z.infer<typeof supportAttachmentDownloadSchema>;

export const supportAttachmentIdInputSchema = z.object({ attachmentId: z.string().uuid() }).strict();
export type SupportAttachmentIdInput = z.infer<typeof supportAttachmentIdInputSchema>;
