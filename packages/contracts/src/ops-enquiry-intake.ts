import { z } from 'zod';
import { crmOpportunityStageSchema, outreachAudienceSchema, outreachContactCaptureSchema } from './outreach-crm.js';

/**
 * SP-contacts-01: staff enquiry intake (manual add, list import) and saved segments, owned by svc-ops.
 * Enquiry records are not customers; a customer lives in svc-identity and is only read.
 * The segment cap is a blank owner value: unset refuses with `ops.segment_cap_unset`, never defaulted.
 */
export const OPS_SEGMENT_CAP_UNSET = 'ops.segment_cap_unset' as const;
export const OPS_IMPORT_INVALID = 'ops.import_invalid' as const;
export const OPS_CONTACT_REASON_REQUIRED = 'ops.contact_reason_required' as const;
export const opsEnquiryIntakeErrorCodeSchema = z.enum([OPS_SEGMENT_CAP_UNSET, OPS_IMPORT_INVALID, OPS_CONTACT_REASON_REQUIRED]);
export type OpsEnquiryIntakeErrorCode = z.infer<typeof opsEnquiryIntakeErrorCodeSchema>;

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const businessKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'Expected an opaque business key');

/** Where an enquiry came from. `chat` is the SP-chat-01 pre-chat form. */
export const opsEnquirySourceSchema = z.enum(['manual', 'import', 'invite_form', 'join_form', 'chat']);
export type OpsEnquirySource = z.infer<typeof opsEnquirySourceSchema>;

/** Manual add: reason and source are required; a blank reason maps to `ops.contact_reason_required`. */
export const opsAddContactInputSchema = z
  .object({
    requestId: id,
    contact: outreachContactCaptureSchema,
    source: opsEnquirySourceSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type OpsAddContactInput = z.infer<typeof opsAddContactInputSchema>;

/** One import row; idempotency is (importSource, rowKey), so a second import of the same file adds nothing. */
export const opsImportRowSchema = z
  .object({ line: z.number().int().min(2).safe(), rowKey: businessKey, contact: outreachContactCaptureSchema })
  .strict();
export const opsImportContactsInputSchema = z
  .object({
    importSource: businessKey,
    reason: z.string().trim().min(1).max(500),
    dryRun: z.boolean(),
    header: z.array(z.string().trim().min(1).max(64)).min(1).max(64),
    rows: z.array(z.unknown()).min(1).max(10_000),
  })
  .strict();
export type OpsImportContactsInput = z.infer<typeof opsImportContactsInputSchema>;

export const opsImportRowOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ line: z.number().int().min(2).safe(), status: z.literal('stored'), contactId: id }).strict(),
  z.object({ line: z.number().int().min(2).safe(), status: z.literal('already_stored'), contactId: id }).strict(),
  z.object({ line: z.number().int().min(2).safe(), status: z.literal('would_store') }).strict(),
  z
    .object({
      line: z.number().int().min(2).safe(),
      status: z.literal('refused'),
      code: z.literal(OPS_IMPORT_INVALID),
      field: z.string().max(64).nullable(),
    })
    .strict(),
]);
export type OpsImportRowOutcome = z.infer<typeof opsImportRowOutcomeSchema>;

export const opsImportReportSchema = z
  .object({ importSource: businessKey, dryRun: z.boolean(), outcomes: z.array(opsImportRowOutcomeSchema) })
  .strict()
  .superRefine((report, ctx) => {
    const lines = report.outcomes.map((row) => row.line);
    if (new Set(lines).size !== lines.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomes'], message: 'Duplicate line outcomes' });
    report.outcomes.forEach((row, index) => {
      const dry = row.status === 'would_store';
      const write = row.status === 'stored';
      if ((report.dryRun && write) || (!report.dryRun && dry))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomes', index, 'status'], message: 'Outcome does not match dry run' });
    });
  });
export type OpsImportReport = z.infer<typeof opsImportReportSchema>;

/** Saved filter over enquiry attributes. */
export const opsSegmentFilterSchema = z
  .object({
    stages: z.array(crmOpportunityStageSchema).max(7).optional(),
    sources: z.array(opsEnquirySourceSchema).max(5).optional(),
    interests: z.array(outreachAudienceSchema).max(5).optional(),
    createdFrom: timestamp.optional(),
    createdTo: timestamp.optional(),
  })
  .strict()
  .refine((f) => !f.createdFrom || !f.createdTo || Date.parse(f.createdFrom) <= Date.parse(f.createdTo), {
    path: ['createdTo'],
    message: 'Created range is reversed',
  });
export type OpsSegmentFilter = z.infer<typeof opsSegmentFilterSchema>;

export const opsSegmentSaveInputSchema = z
  .object({ requestId: id, name: z.string().trim().min(1).max(120), filter: opsSegmentFilterSchema })
  .strict();
export type OpsSegmentSaveInput = z.infer<typeof opsSegmentSaveInputSchema>;

export const opsSegmentSchema = z
  .object({
    segmentId: id,
    name: z.string().trim().min(1).max(120),
    filter: opsSegmentFilterSchema,
    count: z.number().int().nonnegative().safe(),
    savedAt: timestamp,
  })
  .strict();
export type OpsSegment = z.infer<typeof opsSegmentSchema>;

/** Cap is unset (blank owner value) or a set positive count; never a default. */
export const opsSegmentCapSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unset'), code: z.literal(OPS_SEGMENT_CAP_UNSET) }).strict(),
  z.object({ status: z.literal('set'), cap: z.number().int().positive().safe() }).strict(),
]);
export type OpsSegmentCap = z.infer<typeof opsSegmentCapSchema>;

export const opsSegmentListSchema = z.object({ cap: opsSegmentCapSchema, segments: z.array(opsSegmentSchema) }).strict();
export type OpsSegmentList = z.infer<typeof opsSegmentListSchema>;

export interface OpsEnquiryIntakeContract {
  addContact(input: OpsAddContactInput): Promise<{ contactId: string; created: boolean }>;
  importContacts(input: OpsImportContactsInput): Promise<OpsImportReport>;
  saveSegment(input: OpsSegmentSaveInput): Promise<OpsSegment>;
  listSegments(): Promise<OpsSegmentList>;
}
