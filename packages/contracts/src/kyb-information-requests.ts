import { z } from 'zod';
import { kybUploadRulesSchema } from './kyb-documents.js';

/**
 * Information requests (J-merchant-02 step 4): INTAFACED's compliance reviewer asks a business for something more, with
 * a due date. The business answers once, with a note, a file, or both; every file is scanned for malware before it is
 * kept, and an infected file is refused and never stored. The reviewer closes the request, and the business sees who
 * closed it and when. Nothing here moves money.
 *
 * A request is open, answered or closed. `pastDue` is set while it is open after its due date. The file size cap and
 * the accepted types are the owner's document upload rules; the scanner is an outside service, and while none is
 * connected a file answer refuses `pay.kyb_scan_unconfigured` (a note alone still works).
 */
export const KYB_REQUEST_STATES = ['open', 'answered', 'closed'] as const;
export const kybRequestStateSchema = z.enum(KYB_REQUEST_STATES);
export type KybRequestState = z.infer<typeof kybRequestStateSchema>;

/** Characters as people count them (code points), the way the stored text is checked. */
const charCount = (text: string): number => [...text].length;
const words = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((text) => charCount(text) >= min && charCount(text) <= max, `${min} to ${max} characters`);

const requestIdSchema = z.string().guid();

/** A file as kept: only a file the scanner called clean is ever stored. */
export const kybRequestFileSchema = z
  .object({
    id: z.string().guid(),
    contentType: z.string().min(1).max(128),
    byteLength: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type KybRequestFile = z.infer<typeof kybRequestFileSchema>;

export const kybRequestAnswerSchema = z
  .object({
    note: z.string().nullable(),
    file: kybRequestFileSchema.nullable(),
    answeredAt: z.string(),
  })
  .strict();

export const kybInformationRequestSchema = z
  .object({
    id: requestIdSchema,
    merchantId: z.string().guid(),
    text: z.string(),
    dueAt: z.string(),
    state: kybRequestStateSchema,
    /** Open after its due date. An answered or closed request is never past due. */
    pastDue: z.boolean(),
    createdAt: z.string(),
    /** The reviewer who asked. */
    createdBy: z.string(),
    answer: kybRequestAnswerSchema.nullable(),
    /** Who closed it, when, and the note they left; all null until closed. */
    closedBy: z.string().nullable(),
    closedAt: z.string().nullable(),
    closeNote: z.string().nullable(),
  })
  .strict();
export type KybInformationRequest = z.infer<typeof kybInformationRequestSchema>;

/** Whether a scanner is connected; `not_connected` names the outside service that is missing. */
export const kybRequestScannerSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('connected') }).strict(),
  z.object({ status: z.literal('not_connected'), notConnected: z.literal('vendor.malware_scan') }).strict(),
]);

/** One merchant's requests, newest first, with what a file answer needs. */
export const kybRequestsViewSchema = z
  .object({
    merchantId: z.string().guid(),
    requests: z.array(kybInformationRequestSchema),
    /** Null while the owner has not published upload rules; a file answer then refuses `pay.kyb_upload_rules_unset`. */
    uploadRules: kybUploadRulesSchema.nullable(),
    scanner: kybRequestScannerSchema,
  })
  .strict();
export type KybRequestsView = z.infer<typeof kybRequestsViewSchema>;

export const kybRequestsListInputSchema = z.object({ merchantId: z.string().guid() }).strict();

/**
 * Ask a merchant for more. `requestKey` is the reviewer's business key for this request: the same key again returns
 * the same request, and the same key with other words is a conflict. The due date must be in the future.
 */
export const kybRequestCreateInputSchema = z
  .object({
    merchantId: z.string().guid(),
    requestKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9:._-]{8,128}$/),
    text: words(3, 2000),
    dueAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type KybRequestCreateInput = z.infer<typeof kybRequestCreateInputSchema>;

/** The business's one answer: a note, a file, or both. The same answer again returns the request unchanged. */
export const kybRequestAnswerInputSchema = z
  .object({
    requestId: requestIdSchema,
    note: words(1, 2000).nullish(),
    file: z
      .object({
        contentType: z.string().trim().min(1).max(128),
        /** Base64 bytes. The owner's size cap is applied to the decoded size. The HTTP body limits in front of svc-pay cap the whole request first, so a cap above them refuses there (#6228). */
        bytesBase64: z.string().min(1).max(40_000_000),
      })
      .strict()
      .nullish(),
  })
  .strict()
  .refine((input) => Boolean(input.note) || Boolean(input.file), { message: 'an answer needs a note or a file', path: ['note'] });
export type KybRequestAnswerInput = z.infer<typeof kybRequestAnswerInputSchema>;

/** Close a request, open or answered, with a note the business reads. Closing it again with the same note changes nothing. */
export const kybRequestCloseInputSchema = z.object({ requestId: requestIdSchema, note: words(3, 1000) }).strict();

export const kybRequestResultSchema = z.object({ request: kybInformationRequestSchema }).strict();

/** The bytes of an answer's file, for a compliance reviewer. Each read is recorded. */
export const kybRequestFileInputSchema = z.object({ requestId: requestIdSchema }).strict();
export const kybRequestFileBytesSchema = z
  .object({
    requestId: requestIdSchema,
    contentType: z.string().min(1).max(128),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytesBase64: z.string().min(1),
  })
  .strict();
export type KybRequestFileBytes = z.infer<typeof kybRequestFileBytesSchema>;
