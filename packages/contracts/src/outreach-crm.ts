import { z } from 'zod';

/**
 * Public intake and private CRM boundary, owned by svc-ops.
 * These records describe enquiries, never accounts, balances or received funds.
 * Capture success requires durable persistence; validation alone is not capture.
 */
export const outreachAudienceSchema = z.enum(['investor', 'trader', 'merchant', 'academy', 'partner']);
export type OutreachAudience = z.infer<typeof outreachAudienceSchema>;

const id = z.string().guid();
const timestamp = z.string().datetime({ offset: true });
const shortText = z.string().trim().min(1).max(160);
const message = z.string().trim().max(2000);
const country = z.string().regex(/^[A-Z]{2}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const website = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'Website must use HTTP or HTTPS');

function unique<T extends z.ZodTypeAny>(schema: T, max: number) {
  return z
    .array(schema)
    .min(1)
    .max(max)
    .refine((values) => new Set(values).size === values.length, 'Duplicate selections are not allowed');
}

/** Decimal strings only. A stated contribution is indicative, not a balance. */
export const outreachIndicativeAmountSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('undecided') }).strict(),
  z
    .object({
      status: z.literal('stated'),
      amount: z
        .string()
        .max(60)
        .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/, 'Amount must be a non-negative decimal string'),
      currency,
    })
    .strict(),
]);
export type OutreachIndicativeAmount = z.infer<typeof outreachIndicativeAmountSchema>;

export const outreachTimingSchema = z.enum(['as_available', 'within_three_months', 'later', 'undecided']);
const timingFields = { timing: outreachTimingSchema, message: message.optional() };

const investorAnswers = z
  .object({
    investorType: z.enum(['individual', 'family_office', 'fund', 'strategic', 'other']),
    participation: z.enum(['direct', 'introduction', 'both']),
    decisionRole: z.enum(['decision_maker', 'adviser', 'introducer', 'other']),
    indicativeContribution: outreachIndicativeAmountSchema,
    ...timingFields,
  })
  .strict();

const traderAnswers = z
  .object({
    markets: unique(z.enum(['spot', 'derivatives', 'copy_trading', 'algorithmic', 'other']), 5),
    experience: z.enum(['beginner', 'intermediate', 'advanced']),
    role: z.enum(['individual', 'professional', 'community']),
    platformInterest: shortText,
    ...timingFields,
  })
  .strict();

const merchantVolume = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }).strict(),
  z
    .object({
      status: z.literal('stated'),
      amount: z
        .string()
        .max(60)
        .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/, 'Volume must be a non-negative decimal string'),
      currency,
      period: z.enum(['daily', 'monthly', 'annual']),
    })
    .strict(),
]);

const merchantAnswers = z
  .object({
    businessName: shortText,
    website: website.optional(),
    industry: shortText,
    operatingCountries: unique(country, 50),
    processingVolume: merchantVolume,
    services: unique(z.enum(['payment_acceptance', 'settlement', 'payouts', 'other']), 4),
    ...timingFields,
  })
  .strict();

const academyAnswers = z
  .object({
    learningGoal: shortText,
    experience: z.enum(['beginner', 'intermediate', 'advanced']),
    subjects: unique(z.string().trim().min(1).max(80), 10),
    format: z.enum(['self_paced', 'live', 'cohort', 'no_preference']),
    ...timingFields,
  })
  .strict();

const partnerAnswers = z
  .object({
    expertise: shortText,
    contribution: z.string().trim().min(1).max(2000),
    relationship: z.enum(['collaboration', 'partnership', 'undecided']),
    scope: message.optional(),
    ...timingFields,
  })
  .strict();

/** Version is pinned to the published questions; unknown versions refuse. */
export const outreachQuestionnaireSchema = z.discriminatedUnion('audience', [
  z.object({ audience: z.literal('investor'), version: z.literal(1), answers: investorAnswers }).strict(),
  z.object({ audience: z.literal('trader'), version: z.literal(1), answers: traderAnswers }).strict(),
  z.object({ audience: z.literal('merchant'), version: z.literal(1), answers: merchantAnswers }).strict(),
  z.object({ audience: z.literal('academy'), version: z.literal(1), answers: academyAnswers }).strict(),
  z.object({ audience: z.literal('partner'), version: z.literal(1), answers: partnerAnswers }).strict(),
]);
export type OutreachQuestionnaire = z.infer<typeof outreachQuestionnaireSchema>;

export const outreachContactCaptureSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().max(254).email(),
    organisationName: shortText.optional(),
    country: country.optional(),
    interests: unique(outreachAudienceSchema, 5),
    marketingOptIn: z.boolean(),
  })
  .strict();
export type OutreachContactCapture = z.infer<typeof outreachContactCaptureSchema>;

/**
 * Client-generated 256-bit capability, independent of the request ID.
 * Persist only its hash. Never log, put in analytics URLs, or return through
 * a contact lookup. Retries must authenticate this same capability before
 * replaying a result; a request ID or email is not continuation authority.
 */
export const outreachContinuationTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, 'Expected a canonical 256-bit capability');

export const outreachCaptureInputSchema = z
  .object({
    requestId: id,
    continuationToken: outreachContinuationTokenSchema,
    contact: outreachContactCaptureSchema,
    /** Untrusted opaque hint; the server resolves it to a campaign, never an identity. */
    sourceKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,128}$/)
      .optional(),
  })
  .strict();
export type OutreachCaptureInput = z.infer<typeof outreachCaptureInputSchema>;

export const outreachContinuationInputSchema = z.object({ submissionId: id, continuationToken: outreachContinuationTokenSchema }).strict();
export type OutreachContinuationInput = z.infer<typeof outreachContinuationInputSchema>;

/** No canonical contact ID, email membership, pipeline state or staff data. */
export const outreachCaptureReceiptSchema = z
  .object({ submissionId: id, revision: z.number().int().positive(), capturedAt: timestamp, continuationExpiresAt: timestamp })
  .strict();
export type OutreachCaptureReceipt = z.infer<typeof outreachCaptureReceiptSchema>;

export const outreachQuestionnaireInputSchema = outreachContinuationInputSchema
  .extend({ requestId: id, expectedRevision: z.number().int().positive(), questionnaire: outreachQuestionnaireSchema })
  .strict();
export type OutreachQuestionnaireInput = z.infer<typeof outreachQuestionnaireInputSchema>;

const submissionFields = {
  submissionId: id,
  revision: z.number().int().positive(),
  contact: outreachContactCaptureSchema,
  questionnaires: z.array(outreachQuestionnaireSchema).max(5),
  capturedAt: timestamp,
  completedAt: timestamp.nullable(),
};

function validateSubmission(draft: z.infer<z.ZodObject<typeof submissionFields>>, ctx: z.RefinementCtx): void {
  const audiences = draft.questionnaires.map((q) => q.audience);
  if (new Set(audiences).size !== audiences.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questionnaires'], message: 'Duplicate audience answers' });
  }
  if (audiences.some((audience) => !draft.contact.interests.includes(audience))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questionnaires'], message: 'Audience is outside selected interests' });
  }
  if (draft.completedAt !== null && draft.contact.interests.some((audience) => !audiences.includes(audience))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'Selected questionnaires are incomplete' });
  }
  if (draft.completedAt !== null && Date.parse(draft.completedAt) < Date.parse(draft.capturedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'Completion precedes capture' });
  }
}

/** Returned only after validating an unexpired continuation capability. */
export const outreachDraftSchema = z
  .object({ ...submissionFields, continuationExpiresAt: timestamp })
  .strict()
  .superRefine(validateSubmission);
export type OutreachDraft = z.infer<typeof outreachDraftSchema>;

/** Staff can read the original answers without obtaining a prospect's capability. */
export const crmSubmissionSchema = z
  .object({ ...submissionFields, contactId: id })
  .strict()
  .superRefine(validateSubmission);
export type CrmSubmission = z.infer<typeof crmSubmissionSchema>;

export const crmEmailEvidenceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unverified') }).strict(),
  z
    .object({
      status: z.literal('verified'),
      method: z.enum(['owned_email_challenge', 'document_provider']),
      evidenceRef: z.string().min(1).max(128),
      verifiedAt: timestamp,
    })
    .strict(),
]);

export const crmContactSchema = z
  .object({
    id,
    name: z.string().min(1).max(120),
    email: z.string().max(254).email(),
    emailEvidence: crmEmailEvidenceSchema,
    organisationIds: z.array(id).max(50),
    interests: unique(outreachAudienceSchema, 5),
    /** Requires verified ownership or an attributed operator action; never email equality alone. */
    platformIdentity: z
      .object({
        userId: id,
        method: z.enum(['verified_ownership', 'operator']),
        evidenceRef: z.string().min(1).max(128),
        linkedAt: timestamp,
      })
      .strict()
      .nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type CrmContact = z.infer<typeof crmContactSchema>;

export const crmOrganisationSchema = z
  .object({ id, name: shortText, website: website.nullable(), countries: z.array(country).max(50), createdAt: timestamp })
  .strict();
export type CrmOrganisation = z.infer<typeof crmOrganisationSchema>;

export const crmInvestorStageSchema = z.enum(['new', 'qualified', 'diligence', 'terms', 'closed']);
export const crmCommunityStageSchema = z.enum(['new', 'qualified', 'invited', 'onboarding', 'closed']);
export const crmOpportunityStageSchema = z.enum(['new', 'qualified', 'diligence', 'terms', 'invited', 'onboarding', 'closed']);
export type CrmOpportunityStage = z.infer<typeof crmOpportunityStageSchema>;

const opportunityFields = {
  id,
  contactId: id,
  organisationId: id.nullable(),
  submissionId: id,
  ownerUserId: id,
  revision: z.number().int().positive(),
  nextAction: z.object({ description: shortText, dueAt: timestamp }).strict().nullable(),
  closedDisposition: z.enum(['proceeded', 'declined', 'withdrawn', 'waitlisted', 'duplicate']).nullable(),
  closingEvidenceRef: z.string().trim().min(1).max(256).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
};

/** Closing an opportunity never implies payment or allocates equity. */
export const crmOpportunitySchema = z
  .discriminatedUnion('audience', [
    z
      .object({
        ...opportunityFields,
        audience: z.literal('investor'),
        stage: crmInvestorStageSchema,
        indicativeContribution: outreachIndicativeAmountSchema,
      })
      .strict(),
    ...(['trader', 'merchant', 'academy', 'partner'] as const).map((audience) =>
      z.object({ ...opportunityFields, audience: z.literal(audience), stage: crmCommunityStageSchema }).strict(),
    ),
  ])
  .superRefine((row, ctx) => {
    const closed = row.stage === 'closed';
    if (closed !== (row.closedDisposition !== null && row.closingEvidenceRef !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['closedDisposition'], message: 'Closed stage requires disposition and evidence' });
    }
    if (!closed && (row.closedDisposition !== null || row.closingEvidenceRef !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['closedDisposition'], message: 'Open stage cannot carry closing facts' });
    }
    if (closed ? row.nextAction !== null : row.nextAction === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextAction'],
        message: 'Open opportunities require a next action; closed opportunities do not',
      });
    }
  });
export type CrmOpportunity = z.infer<typeof crmOpportunitySchema>;

/** Validate against the persisted audience, not an audience supplied by the caller. */
export function crmStageFitsAudience(audience: OutreachAudience, stage: CrmOpportunityStage): boolean {
  return (audience === 'investor' ? crmInvestorStageSchema : crmCommunityStageSchema).safeParse(stage).success;
}

export const crmStageChangeInputSchema = z
  .object({
    requestId: id,
    opportunityId: id,
    expectedRevision: z.number().int().positive(),
    stage: crmOpportunityStageSchema,
    reason: z.string().trim().min(1).max(500),
    closedDisposition: opportunityFields.closedDisposition,
    closingEvidenceRef: opportunityFields.closingEvidenceRef,
    nextAction: opportunityFields.nextAction,
  })
  .strict()
  .superRefine((input, ctx) => {
    const closingFieldsPresent = input.closedDisposition !== null && input.closingEvidenceRef !== null;
    if (input.stage === 'closed' ? !closingFieldsPresent : input.closedDisposition !== null || input.closingEvidenceRef !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['closedDisposition'], message: 'Closing facts must match the stage' });
    }
    if (input.stage === 'closed' ? input.nextAction !== null : input.nextAction === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nextAction'], message: 'Next action must match the stage' });
    }
  });
export type CrmStageChangeInput = z.infer<typeof crmStageChangeInputSchema>;

/**
 * Edits the pending next action only: no stage change and no reason. The service writes the "next_action_changed"
 * activity (note = description, referenceId = dueAt) and replaces the pending next-action task.
 */
export const crmNextActionInputSchema = z
  .object({
    requestId: id,
    opportunityId: id,
    expectedRevision: z.number().int().positive(),
    description: shortText,
    dueAt: timestamp,
  })
  .strict();
export type CrmNextActionInput = z.infer<typeof crmNextActionInputSchema>;

export const crmActivitySchema = z
  .object({
    id,
    opportunityId: id,
    sequence: z.number().int().positive(),
    kind: z.enum([
      'note',
      'assigned',
      'stage_changed',
      'next_action_changed',
      'questionnaire_submitted',
      'call_invited',
      'call_booked',
      'email_status',
    ]),
    /** Filled by the authenticated service; input schemas never accept an operator identity. */
    actor: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('operator'), userId: id }).strict(),
      z.object({ kind: z.literal('prospect'), submissionId: id }).strict(),
      z.object({ kind: z.literal('system'), jobId: id }).strict(),
    ]),
    note: message.nullable(),
    referenceId: z.string().min(1).max(128).nullable(),
    occurredAt: timestamp,
  })
  .strict();
export type CrmActivity = z.infer<typeof crmActivitySchema>;

export const crmTaskSchema = z
  .object({
    id,
    opportunityId: id,
    ownerUserId: id,
    description: shortText,
    dueAt: timestamp,
    status: z.enum(['pending', 'completed', 'cancelled']),
    updatedAt: timestamp,
  })
  .strict();
export type CrmTask = z.infer<typeof crmTaskSchema>;

/** Free/unconfigured is unavailable, never a successful sync with zero views. */
export const crmEngagementSyncSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('disabled'), reason: z.enum(['api_access_unavailable', 'unconfigured']) }).strict(),
  z.object({ status: z.literal('not_started') }).strict(),
  z.object({ status: z.literal('synced'), lastAttemptAt: timestamp, lastSuccessAt: timestamp }).strict(),
  z.object({ status: z.literal('failed'), lastAttemptAt: timestamp, lastSuccessAt: timestamp.nullable(), errorCode: shortText }).strict(),
]);
export type CrmEngagementSync = z.infer<typeof crmEngagementSyncSchema>;

export const crmListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200),
    cursor: z.string().min(1).max(256).optional(),
    audience: outreachAudienceSchema.optional(),
    stage: crmOpportunityStageSchema.optional(),
    ownerUserId: id.optional(),
    query: z.string().trim().max(160).optional(),
  })
  .strict();
export type CrmListInput = z.infer<typeof crmListInputSchema>;

/** Private list companions avoid one authenticated detail request per visible row. */
export const crmSubmissionSummarySchema = z
  .object({ submissionId: id, completedAt: timestamp.nullable(), organisationName: shortText.nullable() })
  .strict();
/**
 * Present only for a search whose match came through a merged-away (alias) contact rather than the visible one:
 * the old name the founder typed part of, so the row can say "also: <old name>".
 */
export const crmAliasMatchSchema = z.object({ opportunityId: id, name: z.string().min(1).max(120) }).strict();
export type CrmAliasMatch = z.infer<typeof crmAliasMatchSchema>;
export const crmOpportunityPageSchema = z
  .object({
    items: z.array(crmOpportunitySchema).max(200),
    contacts: z.array(crmContactSchema).max(200),
    submissions: z.array(crmSubmissionSummarySchema).max(200),
    aliasMatches: z.array(crmAliasMatchSchema).max(200).optional(),
    nextCursor: z.string().min(1).max(256).nullable(),
  })
  .strict()
  .superRefine((page, ctx) => {
    const ids = page.contacts.map((contact) => contact.id);
    if (
      new Set(ids).size !== ids.length ||
      page.items.some((item) => !ids.includes(item.contactId)) ||
      ids.some((contactId) => !page.items.some((item) => item.contactId === contactId))
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contacts'], message: 'List contacts must match the visible opportunities' });
    }
    const submissionIds = page.submissions.map((submission) => submission.submissionId);
    if (
      new Set(submissionIds).size !== submissionIds.length ||
      page.items.some((item) => !submissionIds.includes(item.submissionId)) ||
      submissionIds.some((submissionId) => !page.items.some((item) => item.submissionId === submissionId))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['submissions'],
        message: 'List submissions must match the visible opportunities',
      });
    if (page.aliasMatches?.some((match) => !page.items.some((item) => item.id === match.opportunityId)))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aliasMatches'],
        message: 'Alias matches must belong to the visible opportunities',
      });
  });
export type CrmOpportunityPage = z.infer<typeof crmOpportunityPageSchema>;

export const crmNoteInputSchema = z.object({ requestId: id, opportunityId: id, note: z.string().trim().min(1).max(2000) }).strict();
export type CrmNoteInput = z.infer<typeof crmNoteInputSchema>;

export const crmAssignmentInputSchema = z
  .object({ requestId: id, opportunityId: id, expectedRevision: z.number().int().positive(), ownerUserId: id })
  .strict();
export type CrmAssignmentInput = z.infer<typeof crmAssignmentInputSchema>;

/** Capture must not expose staff records; staff methods require real authenticated authority. */
export interface OutreachCrmContract {
  capture(input: OutreachCaptureInput): Promise<OutreachCaptureReceipt>;
  resume(input: OutreachContinuationInput): Promise<OutreachDraft>;
  answer(input: OutreachQuestionnaireInput): Promise<OutreachDraft>;
  listOpportunities(input: CrmListInput): Promise<CrmOpportunityPage>;
  getOpportunity(input: { opportunityId: string }): Promise<{
    opportunity: CrmOpportunity;
    contact: CrmContact;
    submission: CrmSubmission;
    organisation: CrmOrganisation | null;
    activities: CrmActivity[];
    tasks: CrmTask[];
  } | null>;
  assign(input: CrmAssignmentInput): Promise<CrmOpportunity>;
  changeStage(input: CrmStageChangeInput): Promise<CrmOpportunity>;
  updateNextAction(input: CrmNextActionInput): Promise<CrmOpportunity>;
  addNote(input: CrmNoteInput): Promise<CrmActivity>;
}
