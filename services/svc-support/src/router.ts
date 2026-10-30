import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  createTicketWireInputSchema,
  SUPPORT_CATEGORY_UNKNOWN,
  supportCategoriesSchema,
  supportMyTicketPropertiesSchema,
  supportTicketCategorySchema,
  escalateTicketInputSchema,
  getKbArticleInputSchema,
  setKbAudienceInputSchema,
  type SupportAttachment,
  publicProcedure,
  router,
  scopedProcedure,
  supportAccountGroundingSchema,
  supportAttachmentDownloadSchema,
  supportBulkInputSchema,
  supportBulkPolicySchema,
  supportBulkResultSchema,
  supportMergeInputSchema,
  supportMergePreviewInputSchema,
  supportMergePreviewSchema,
  supportMergeResultSchema,
  supportAttachmentIdInputSchema,
  supportAttachmentSchema,
  supportCaseFileSchema,
  supportCommentSchema,
  supportInternalNoteInputSchema,
  supportKbArticleSchema,
  supportTicketEventSchema,
  supportAwaitingMineSchema,
  supportTicketLifecycleSchema,
  supportTicketPropertiesSchema,
  supportTicketPropertyChangeSchema,
  supportCreatedByRequestInputSchema,
  supportTicketSchema,
  supportTicketStatusSchema,
  supportViewCountsSchema,
  supportViewDeleteInputSchema,
  supportViewListSchema,
  supportViewSaveInputSchema,
  supportViewSchema,
  supportExpectedSequenceSchema,
} from '@intafaced/contracts';
import { MemoryContactBook, type ContactBook } from './contact-channels.js';
import { contactProcedures } from './contact-router.js';
import type { AttachmentMeta } from './store.js';
import { attachmentProcedures } from './attachment-router.js';
import { MemoryAttachmentSettingsBook, type AttachmentSettingsBook } from './attachment-settings.js';
import { MemorySurveyBook, type SurveyBook } from './survey-settings.js';
import { surveyProcedures } from './survey-router.js';
import { MemoryHelpCentreBook, type HelpCentreBook } from './help-centre.js';
import { helpCentreGate, helpCentreProcedures } from './help-centre-router.js';
import { MemoryFormsStore, RequestFormError, RequestForms } from './request-forms.js';
import { DeskMacros, MemoryMacroBook } from './desk-macros.js';
import { macroProcedures } from './desk-macros-router.js';
import { mapRequestForm, requestFormProcedures } from './request-forms-router.js';
import { MemoryKbLibraryBook, type KbLibraryBook } from './kb-library.js';
import { kbLibraryProcedures } from './kb-library-router.js';
import { kbReviewProcedures } from './kb-review-router.js';
import { KbAuthoring } from './kb-authoring.js';
import { MemoryKbReviewBook } from './kb-review.js';
import { MemorySupportStore } from './store.js';
import { kbFeedbackProcedures } from './kb-feedback-router.js';
import { unwiredApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';
import { describeSupportDeskPolicy } from './desk-policy.js';
import { describeKbPolicy } from './kb-policy.js';
import { SupportError, SupportService, kbViewerOf, requireSupportOps } from './support-service.js';
import type { TicketKbLoopObserver } from './ticket-kb-loop-observation.js';
import { ticketOrderReadSchema } from './ticket-order.js';
import { userCopy } from './user-copy.js';

const queueEntrySchema = z.object({
  ticketId: z.string().guid(),
  userId: z.string().guid(),
  category: z.string().min(1),
  status: supportTicketStatusSchema,
  subject: z.string().min(1),
  score: z.number().finite(),
  ageMs: z.number().nonnegative(),
  createdAt: z.string().datetime(),
  timingKind: z.literal('score_not_promise'),
  sla: z.literal(false),
});

const queueResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), entries: z.array(queueEntrySchema) }),
  z.object({ status: z.literal('empty') }),
]);

export function mapError(err: unknown): never {
  if (err instanceof SupportError) {
    const message = err.missingKey ? `${userCopy(err.code)} ${err.missingKey}` : userCopy(err.code);
    if (err.code === 'support.not_found' || err.code === 'support.claim.not_found') {
      throw new TRPCError({ code: 'NOT_FOUND', message });
    }
    if (err.code === 'support.claim.already_claimed' || err.code === 'support.kb.revision_stale' || err.code === 'support.already_rated') {
      throw new TRPCError({ code: 'CONFLICT', message });
    }
    if (
      err.code === 'support.claim.not_queueable' ||
      err.code === 'support.claim.invalid_operator' ||
      err.code === 'support.claim.queue_empty' ||
      // A lifecycle move that is not available from where the ticket is now,
      // and an escalation that cites nothing, are both "the state you are
      // asking from does not permit this" rather than a malformed request.
      err.code === 'support.transition_illegal' ||
      err.code === 'support.transition_same_status' ||
      err.code === 'support.case_file.ungrounded' ||
      err.code === 'support.case_file.empty_summary' ||
      // Closed is terminal — same family as illegal lifecycle moves.
      err.code === 'support.escalation.terminal' ||
      err.code === 'support.comment.terminal' ||
      err.code === 'support.kb.not_published' ||
      err.code === 'support.kb_version_unknown' ||
      err.code === 'support.identity_grounding_unwired' ||
      err.code === 'support.order.user_mismatch' ||
      err.code === 'support.settle.refused' ||
      err.code === 'support.kb_review_required' ||
      // listQueue / listAll / listMine / listComments / events / listKb / searchKb page size unpublished. Blank is not 100.
      err.code === 'support.queue_list_limit_unset' ||
      err.code === 'support.list_all_limit_unset' ||
      err.code === 'support.list_mine_limit_unset' ||
      err.code === 'support.list_comments_limit_unset' ||
      err.code === 'support.list_attachments_limit_unset' ||
      err.code === 'support.list_events_limit_unset' ||
      err.code === 'support.list_kb_limit_unset' ||
      err.code === 'support.staff_bootstrap' ||
      err.code === 'support.heartbeat_window_unset' ||
      err.code === 'support.ticket_closed' ||
      err.code === 'support.follow_up_invalid' ||
      err.code === 'support.hold_reason_required' ||
      err.code === 'support.rating_window_invalid' ||
      err.code === 'support.release.not_queueable' ||
      err.code === 'support.assign.not_queueable' ||
      err.code === 'support.attachments_unconfigured' ||
      err.code === 'support.bulk_cap_unset' ||
      err.code === 'support.view_cap_unset' ||
      err.code === 'support.view_cap_reached' ||
      err.code === 'support.filter_invalid' ||
      err.code === 'support.sort_invalid' ||
      err.code === 'support.merge_not_allowed' ||
      err.code === 'support.merge_same_ticket' ||
      err.code === 'support.rate_status_refused' ||
      err.code === 'support.attachment_scan_refused' ||
      err.code === 'support.attachment_count_unset' ||
      err.code === 'support.attachment_scan_unknown' ||
      err.code === 'support.attachment_count_reached' ||
      err.code === 'support.attachment_too_large' ||
      err.code === 'support.feedback_rate_limit_unset' ||
      err.code === 'support.comment_cap_unset' ||
      err.code === 'support.comment_cap_reached' ||
      err.code === 'support.assistant_model_unset' ||
      err.code === 'support.kb_section_unknown' ||
      err.code === 'support.fraud_route_unset' ||
      err.code === 'support.fraud_route_missing' ||
      err.code === 'support.fraud_report_key_required'
    ) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
    }
    if (err.code === 'support.feedback_rate_exceeded') {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message });
    }
    if (
      err.code === 'support.not_lead' ||
      err.code === 'support.not_staff' ||
      err.code === 'support.release.not_assignee' ||
      err.code === 'support.view_not_owner'
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message });
    }
    if (
      err.code === 'support.idempotency_conflict' ||
      err.code === 'support.view_revision_stale' ||
      err.code === 'support.stale_ticket' ||
      err.code === 'support.group_member_duplicate' ||
      err.code === 'support.group_name_taken'
    ) {
      throw new TRPCError({ code: 'CONFLICT', message });
    }
    if (err.code === 'support.release.not_found' || err.code === 'support.assign.not_found' || err.code === 'support.group_unknown') {
      throw new TRPCError({ code: 'NOT_FOUND', message });
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message });
  }
  throw err;
}

const deskGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  memberIds: z.array(z.string()),
});

/** Desk scope for the doors that page the whole queue. Left out, every operator sees the queue. */
export type DeskScopeReader = Pick<SupportService, 'deskIsRestricted' | 'listAllTicketsInScope'>;

/** The wire form of a stored file: the scan state is public, the store key is not. */
function attachmentWire(meta: AttachmentMeta): SupportAttachment {
  const { id, ticketId, ownerId, contentType, byteLength, scanState, uploadedBy, createdAt } = meta;
  return { id, ticketId, ownerId, contentType, byteLength, scanState, uploadedBy, createdAt };
}

export function createSupportRouter(
  support: SupportService,
  loop?: TicketKbLoopObserver,
  internalServiceSecret?: string | null,
  scope?: DeskScopeReader,
  contact: ContactBook = new MemoryContactBook(),
  attachmentSettings: AttachmentSettingsBook = new MemoryAttachmentSettingsBook(),
  surveys: SurveyBook = new MemorySurveyBook(),
  surveyApprovals: ActionApprovalConsumer = unwiredApprovalConsumer(),
  helpCentre: HelpCentreBook = new MemoryHelpCentreBook(),
  kbLibrary: KbLibraryBook = new MemoryKbLibraryBook(),
  forms: RequestForms = new RequestForms(new MemoryFormsStore(), { forms: null, fields: null }),
  macros: DeskMacros = new DeskMacros(new MemoryMacroBook(), support, null),
  kbAuthoring: KbAuthoring = new KbAuthoring(new MemorySupportStore(), new MemoryKbReviewBook()),
) {
  const helpCentreOpen = helpCentreGate(helpCentre);
  return router({
    ...macroProcedures(macros),
    ...contactProcedures(contact, support),
    ...attachmentProcedures(attachmentSettings, support),
    ...surveyProcedures(surveys, support, surveyApprovals),
    ...helpCentreProcedures(helpCentre, support),
    ...requestFormProcedures(forms, support),
    ...kbFeedbackProcedures(support, mapError, helpCentreOpen),
    ...kbLibraryProcedures(kbLibrary, support, helpCentreOpen, mapError),
    ...kbReviewProcedures(kbAuthoring, kbLibrary),

    deskPolicy: publicProcedure.query(() => describeSupportDeskPolicy(internalServiceSecret ?? null)),

    kbPolicy: publicProcedure.query(() => describeKbPolicy()),

    /** The categories a person can send, where each goes, and which cannot be sent now (SP-tickets-01). */
    categories: scopedProcedure('support:read')
      .output(supportCategoriesSchema)
      .query(async () => {
        try {
          return await support.categories();
        } catch (err) {
          mapError(err);
        }
      }),

    create: scopedProcedure('support:write')
      .input(createTicketWireInputSchema)
      .output(supportTicketSchema)
      .mutation(async ({ ctx, input: wire }) => {
        // A category the service does not offer is refused by its own code, before anything else is read.
        const category = supportTicketCategorySchema.safeParse(wire.category);
        if (!category.success)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: userCopy(SUPPORT_CATEGORY_UNKNOWN),
            cause: Object.assign(new Error(SUPPORT_CATEGORY_UNKNOWN), { code: SUPPORT_CATEGORY_UNKNOWN }),
          });
        const input = { ...wire, category: category.data };
        const userId = ctx.principal!.userId;
        // A request sent with a form is checked against the stored form before the ticket exists (SP-tickets-03). A
        // replay of a key whose ticket already exists is not refused for a form changed since: it returns that ticket,
        // and keeps the answers only if they still fit and none were kept (a crash between the two writes).
        let checked: Awaited<ReturnType<RequestForms['check']>> | null = null;
        try {
          if (input.form) {
            try {
              checked = await forms.check(input.form);
            } catch (err) {
              // Only a refusal of the answers is forgiven, and only for a key whose ticket already exists.
              if (!(err instanceof RequestFormError)) throw err;
              const prior = input.clientRequestId
                ? await support.createdByRequest({ userId, clientRequestId: input.clientRequestId })
                : null;
              if (!prior) throw mapRequestForm(err);
            }
          }
          const { form: _form, ...ticketInput } = input;
          const ticket = await support.createTicket({ userId, ...ticketInput });
          // The answers are kept once per request; a replay that finds them kept changes nothing.
          if (checked) await forms.record(ticket.id, checked);
          loop?.markTicketCreateSuccess();
          return ticket;
        } catch (err) {
          mapError(err);
        }
      }),

    /** How many of the caller's own requests wait on their reply, and the one that has waited longest. */
    awaitingMine: scopedProcedure('support:read')
      .output(supportAwaitingMineSchema)
      .query(async ({ ctx }) => {
        try {
          return await support.awaitingMine({ userId: ctx.principal!.userId });
        } catch (err) {
          mapError(err);
        }
      }),

    listMine: scopedProcedure('support:read')
      .input(
        z
          .object({
            /**
             * Page size. Optional here so omit reaches the service named
             * refuse (`support.list_mine_limit_unset`) instead of a Zod
             * "Required" that looks like a typo. Blank is not 100; pass 100
             * explicitly when that is the page you want.
             */
            limit: z.number().int().positive().max(500).optional(),
          })
          .optional(),
      )
      .output(z.array(supportTicketSchema))
      .query(async ({ ctx, input }) => {
        try {
          return await support.listMyTickets({ userId: ctx.principal!.userId, limit: input?.limit });
        } catch (err) {
          mapError(err);
        }
      }),

    /** The caller's own request a `create` key made, or null (a page whose create answer was lost reads this). */
    createdByRequest: scopedProcedure('support:read')
      .input(supportCreatedByRequestInputSchema)
      .output(supportTicketSchema.nullable())
      .query(async ({ ctx, input }) => {
        try {
          return await support.createdByRequest({ userId: ctx.principal!.userId, clientRequestId: input.clientRequestId });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Ids of the caller's own tickets that carry a rating. */
    ratedMine: scopedProcedure('support:read')
      .output(z.array(z.string().guid()))
      .query(async ({ ctx }) => {
        try {
          return await support.ratedTicketIds(ctx.principal!.userId);
        } catch (err) {
          mapError(err);
        }
      }),

    /** Operator list — Stage-1 desk spine (no UI required). */
    listAll: scopedProcedure('support:ops')
      .input(
        z
          .object({
            /**
             * Page size. Optional here so omit reaches the service named
             * refuse (`support.list_all_limit_unset`) instead of a Zod
             * "Required" that looks like a typo. Blank is not 100; pass 100
             * explicitly when that is the page you want.
             */
            limit: z.number().int().positive().max(500).optional(),
            /** Loose on purpose: a bad field is `support.filter_invalid`, not a schema error. */
            filter: z.unknown().optional(),
            sort: z.unknown().nullable().optional(),
            /** Subject, body or requester id. Blank is not a search. */
            q: z.string().max(200).optional(),
          })
          .optional(),
      )
      .output(z.array(supportTicketSchema))
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          const asked = input?.filter !== undefined || (input?.sort !== undefined && input.sort !== null) || Boolean(input?.q?.trim());
          if (!asked) {
            if (scope && (await scope.deskIsRestricted())) {
              return await scope.listAllTicketsInScope({ limit: input?.limit, viewerId: ctx.principal!.userId });
            }
            return await support.listAllTickets({ limit: input?.limit });
          }
          const query = { limit: input?.limit, filter: input?.filter, sort: input?.sort, q: input?.q };
          if (scope && (await scope.deskIsRestricted())) {
            return await scope.listAllTicketsInScope({ ...query, viewerId: ctx.principal!.userId });
          }
          return await support.listAllTickets(query);
        } catch (err) {
          mapError(err);
        }
      }),

    get: scopedProcedure('support:read')
      .input(z.object({ ticketId: z.string().guid() }))
      .output(supportTicketSchema)
      .query(async ({ ctx, input }) => {
        try {
          const asOperator = ctx.principal!.scopes.includes('support:ops');
          return await support.getTicket({
            userId: ctx.principal!.userId,
            ticketId: input.ticketId,
            asOperator,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    comment: scopedProcedure('support:write')
      .input(
        z.object({
          ticketId: z.string().guid(),
          body: z.string().min(1).max(10_000),
          /** The caller's key: sent again after a lost reply it answers the first comment and writes no second one. */
          clientRequestId: z.string().min(1).max(200).optional(),
          /** The last trail row (`sequence`) the writer read: a newer row by someone else refuses `support.stale_ticket`. */
          expectedSequence: supportExpectedSequenceSchema.optional(),
        }),
      )
      .output(supportCommentSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          const asOperator = ctx.principal!.scopes.includes('support:ops');
          return await support.comment({
            userId: ctx.principal!.userId,
            ticketId: input.ticketId,
            body: input.body,
            asOperator,
            ...(input.clientRequestId !== undefined ? { clientRequestId: input.clientRequestId } : {}),
            ...(input.expectedSequence !== undefined ? { expectedSequence: input.expectedSequence } : {}),
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /** A staff-only note (SP-tickets-05): never on the customer's thread, and it moves nothing the customer reads. */
    addInternalNote: scopedProcedure('support:ops')
      .input(supportInternalNoteInputSchema)
      .output(supportCommentSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.addInternalNote({
            userId: ctx.principal!.userId,
            ticketId: input.ticketId,
            body: input.body,
            clientRequestId: input.clientRequestId,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    listComments: scopedProcedure('support:read')
      .input(
        z.object({
          ticketId: z.string().guid(),
          /**
           * Page size. Optional here so omit reaches the service named
           * refuse (`support.list_comments_limit_unset`) instead of a Zod
           * "Required" that looks like a typo. Blank is not 100; pass 100
           * explicitly when that is the page you want.
           */
          limit: z.number().int().positive().max(500).optional(),
        }),
      )
      .output(z.array(supportCommentSchema))
      .query(async ({ ctx, input }) => {
        try {
          const asOperator = ctx.principal!.scopes.includes('support:ops');
          return await support.listComments({
            userId: ctx.principal!.userId,
            ticketId: input.ticketId,
            asOperator,
            limit: input.limit,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    setStatus: scopedProcedure('support:ops')
      .input(
        z.object({
          ticketId: z.string().guid(),
          status: supportTicketStatusSchema,
          /** Optional short reason, recorded on the trail row. Not required, so
           *  no existing caller breaks; recorded when supplied. */
          note: z.string().min(1).max(500).optional(),
          /** The last trail row (`sequence`) the operator read: a newer row by someone else refuses `support.stale_ticket`. */
          expectedSequence: supportExpectedSequenceSchema.optional(),
        }),
      )
      .output(supportTicketSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.setStatus({
            operatorId: ctx.principal!.userId,
            ticketId: input.ticketId,
            status: input.status,
            note: input.note,
            ...(input.expectedSequence !== undefined ? { expectedSequence: input.expectedSequence } : {}),
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * The audit trail. `support:read` — the ticket's OWNER can see what
     * happened to their own complaint, which is the point of keeping it.
     * Visibility is decided by the same owner-or-operator rule as `get`.
     */
    events: scopedProcedure('support:read')
      .input(
        z.object({
          ticketId: z.string().guid(),
          /**
           * Page size. Optional here so omit reaches the service named
           * refuse (`support.list_events_limit_unset`) instead of a Zod
           * "Required" that looks like a typo. Blank is not 100; pass 100
           * explicitly when that is the page you want.
           */
          limit: z.number().int().positive().max(500).optional(),
        }),
      )
      .output(z.array(supportTicketEventSchema))
      .query(async ({ ctx, input }) => {
        try {
          return await support.listTicketEvents({
            userId: ctx.principal!.userId,
            ticketId: input.ticketId,
            asOperator: ctx.principal!.scopes.includes('support:ops'),
            limit: input.limit,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * One order, read for this ticket. `userId` is not an input: it comes off
     * the ticket. A mismatch is refused. Trade silence is `unknown`, not a
     * cancel. No ledger post.
     */
    ticketOrder: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid(), orderId: z.string().guid() }).strict())
      .output(ticketOrderReadSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.readTicketOrder({
            operatorId: ctx.principal!.userId,
            ticketId: input.ticketId,
            orderId: input.orderId,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Account state for the ticket's owner, read from svc-identity.
     *
     * NO `userId` INPUT — the id comes off the ticket. `support:ops` plus a
     * free-text user id would be a platform-wide account lookup, which is an
     * authority the scope does not grant.
     */
    accountState: scopedProcedure('support:ops')
      // `.strict()`, unlike every other input on this router, and the reason is
      // this specific procedure. Zod's default is to STRIP unknown keys, so a
      // caller sending `{ ticketId, userId }` would have the userId silently
      // discarded and get the ticket owner's state back instead — the safe
      // answer, returned to a caller who asked a different question and is not
      // told so. Refusing says it out loud, and keeps "there is no way to ask
      // this service about an arbitrary account" a property rather than an
      // accident of zod's defaults.
      .input(z.object({ ticketId: z.string().guid() }).strict())
      .output(supportAccountGroundingSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.readAccountState({
            operatorId: ctx.principal!.userId,
            ticketId: input.ticketId,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Escalate with a case file. Refuses when nothing was read. No money. */
    escalate: scopedProcedure('support:ops')
      .input(escalateTicketInputSchema)
      .output(supportCaseFileSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.escalate({ operatorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** The case file an escalation was made against. null = never escalated. */
    caseFile: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid() }))
      .output(supportCaseFileSchema.nullable())
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.getCaseFile({
            operatorId: ctx.principal!.userId,
            ticketId: input.ticketId,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    listKb: publicProcedure
      .input(
        z
          .object({
            /**
             * Page size. Optional here so omit reaches the service named
             * refuse (`support.list_kb_limit_unset`) instead of a Zod
             * "Required" that looks like a typo. Blank is not 100; pass 100
             * explicitly when that is the page you want.
             */
            limit: z.number().int().positive().max(500).optional(),
          })
          .optional(),
      )
      .output(z.array(supportKbArticleSchema))
      .query(async ({ ctx, input }) => {
        try {
          await helpCentreOpen(ctx.principal);
          return await support.listKb({ limit: input?.limit, viewer: kbViewerOf(ctx.principal) });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Search platform KB spine (i18n keys). Empty q → published list, then page. */
    searchKb: publicProcedure
      .input(
        z
          .object({
            q: z.string().max(200).optional(),
            /**
             * Page size. Optional here so omit reaches the service named
             * refuse (`support.list_kb_limit_unset`) instead of a Zod
             * "Required". Same window as listKb. Blank is not 100; pass 100
             * explicitly when that is the page you want.
             */
            limit: z.number().int().positive().max(500).optional(),
          })
          .optional(),
      )
      .output(z.array(supportKbArticleSchema))
      .query(async ({ ctx, input }) => {
        try {
          await helpCentreOpen(ctx.principal);
          const found = await support.searchKb(input?.q ?? '', { limit: input?.limit, viewer: kbViewerOf(ctx.principal) });
          if (found.length > 0) loop?.markKbSearchSuccess();
          return found;
        } catch (err) {
          mapError(err);
        }
      }),

    /** Single KB article by id — omitted version is latest published; unknown version refuses by name. */
    getKb: publicProcedure
      .input(getKbArticleInputSchema)
      .output(supportKbArticleSchema.nullable())
      .query(async ({ ctx, input }) => {
        try {
          await helpCentreOpen(ctx.principal);
          const article = await support.getKbArticle({ id: input.id, version: input.version }, { viewer: kbViewerOf(ctx.principal) });
          if (article) loop?.markKbGetSuccess();
          return article;
        } catch (err) {
          mapError(err);
        }
      }),

    /** Operator publish. Bumps revision. Stale baseRevision → CONFLICT. */
    publishKb: scopedProcedure('support:ops')
      .input(
        z.object({
          id: z.string().min(1).max(200),
          titleKey: z.string().min(1).max(200),
          bodyKey: z.string().min(1).max(200),
          /** 0 creates a new published row at revision 1. */
          baseRevision: z.number().int().nonnegative(),
          category: z.string().min(1).max(200).nullable().optional(),
          tags: z.array(z.string().min(1).max(200)).max(20).nullable().optional(),
        }),
      )
      .output(supportKbArticleSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.publishKb(input);
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Operator change of who may read an article (public, signed_in or staff). Stale `baseRevision` is a CONFLICT;
     * the same audience again is a no-op that writes no audit row.
     */
    setKbAudience: scopedProcedure('support:ops')
      .input(setKbAudienceInputSchema)
      .output(supportKbArticleSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.setKbAudience({ operatorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Operator unpublish. Hidden from public list/search/get. */
    unpublishKb: scopedProcedure('support:ops')
      .input(
        z.object({
          id: z.string().min(1).max(200),
          baseRevision: z.number().int().positive(),
        }),
      )
      .output(supportKbArticleSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.unpublishKb(input);
        } catch (err) {
          mapError(err);
        }
      }),

    /** Stage-2 — prioritised operator queue (open/pending only). */
    listQueue: scopedProcedure('support:ops')
      .input(
        z
          .object({
            /**
             * Page size. Optional here so omit reaches the service named
             * refuse (`support.queue_list_limit_unset`) instead of a Zod
             * "Required" that looks like a typo. Blank is not 100; pass 100
             * explicitly when that is the page you want.
             */
            limit: z.number().int().positive().max(500).optional(),
            /** Only tickets carrying this label. */
            label: z.string().max(200).optional(),
            filter: z.unknown().optional(),
            sort: z.unknown().nullable().optional(),
            q: z.string().max(200).optional(),
          })
          .optional(),
      )
      .output(queueResultSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          const asked = input?.filter !== undefined || (input?.sort !== undefined && input.sort !== null) || Boolean(input?.q?.trim());
          const q = asked
            ? await support.listOperatorQueue({
                limit: input?.limit,
                ...(input?.label !== undefined ? { label: input.label } : {}),
                filter: input?.filter,
                sort: input?.sort,
                q: input?.q,
                ...(scope && (await scope.deskIsRestricted()) ? { viewerId: ctx.principal!.userId } : {}),
              })
            : input?.label
              ? await support.listOperatorQueue({
                  limit: input.limit,
                  label: input.label,
                  viewerId: scope && (await scope.deskIsRestricted()) ? ctx.principal!.userId : undefined,
                })
              : scope && (await scope.deskIsRestricted())
                ? await support.listOperatorQueue({ limit: input?.limit, viewerId: ctx.principal!.userId })
                : await support.listOperatorQueue({ limit: input?.limit });
          if (q.status === 'empty') return q;
          return { status: 'ok' as const, entries: [...q.entries] };
        } catch (err) {
          mapError(err);
        }
      }),

    /** Stage-2 — peek next queue ticket without claiming. */
    next: scopedProcedure('support:ops')
      .output(queueEntrySchema.nullable())
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return support.peekNext(ctx.principal!.userId);
      }),

    /**
     * Complete a withdrawal / unfreeze / move money. Always refuses.
     * A compromised support channel must not settle through this door.
     */
    settle: scopedProcedure('support:ops')
      .input(
        z.object({
          act: z.enum(['complete_withdrawal', 'unfreeze_account', 'move_money']),
          ticketId: z.string().guid().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.attemptSettlement({
            operatorId: ctx.principal!.userId,
            act: input.act,
            ticketId: input.ticketId,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Owner close. Lifecycle table only. Replay returns the first ticket. */
    close: scopedProcedure('support:write')
      .input(z.object({ ticketId: z.string().guid(), clientRequestId: z.string().min(1).max(200) }))
      .output(supportTicketSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await support.close({ userId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Owner rating. Once per ticket, only when resolved or closed. */
    rate: scopedProcedure('support:write')
      .input(
        z.object({
          ticketId: z.string().guid(),
          score: z.number().int(),
          note: z.string().max(500).optional(),
          clientRequestId: z.string().min(1).max(200),
        }),
      )
      .output(
        z.object({
          ticketId: z.string().guid(),
          userId: z.string().guid(),
          score: z.number().int(),
          note: z.string().nullable(),
          createdAt: z.string().datetime(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await support.rate({ userId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** The caller's own rating, or null when they have not rated. */
    rating: scopedProcedure('support:read')
      .input(z.object({ ticketId: z.string().guid() }))
      .output(
        z
          .object({
            ticketId: z.string().guid(),
            userId: z.string().guid(),
            score: z.number().int(),
            note: z.string().nullable(),
            createdAt: z.string().datetime(),
          })
          .nullable(),
      )
      .query(async ({ ctx, input }) => {
        try {
          return await support.rating({ userId: ctx.principal!.userId, ticketId: input.ticketId, asOperator: false });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Operator read of a rating. Requires support:ops. */
    ratingOps: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid() }))
      .output(
        z
          .object({
            ticketId: z.string().guid(),
            userId: z.string().guid(),
            score: z.number().int(),
            note: z.string().nullable(),
            createdAt: z.string().datetime(),
          })
          .nullable(),
      )
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.rating({ userId: ctx.principal!.userId, ticketId: input.ticketId, asOperator: true });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Founder summary of ratings for requests solved in a stated window. Requires support:ops. */
    ratingSummary: scopedProcedure('support:ops')
      .input(z.object({ from: z.string().datetime(), to: z.string().datetime() }))
      .output(
        z.object({
          from: z.string().datetime(),
          to: z.string().datetime(),
          solved: z.number().int(),
          responses: z.number().int(),
          perScore: z.object({
            '1': z.number().int(),
            '2': z.number().int(),
            '3': z.number().int(),
            '4': z.number().int(),
            '5': z.number().int(),
          }),
          ratedShareBasisPoints: z.number().int().nullable(),
        }),
      )
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.ratingSummary({ viewerId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Owner attach. Unconfigured store, scanner, or limits refuse
     * support.attachments_unconfigured and name the missing key. The answer carries the scan state:
     * a file is stored only once it is clean, and a file the scanner could not judge stays held.
     */
    attach: scopedProcedure('support:write')
      .input(
        z.object({
          ticketId: z.string().guid(),
          clientRequestId: z.string().min(1).max(200),
          contentType: z.string().min(1).max(200),
          bodyBase64: z.string(),
        }),
      )
      .output(supportAttachmentSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return attachmentWire(await support.attach({ userId: ctx.principal!.userId, ...input }));
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Operator attach, for the operator the ticket is assigned to. The file is the ticket owner's and names the operator
     * in `uploadedBy`. Limits, scanner and store are the owner attach's; another operator's ticket answers like none.
     */
    attachOps: scopedProcedure('support:ops')
      .input(
        z.object({
          ticketId: z.string().guid(),
          clientRequestId: z.string().min(1).max(200),
          contentType: z.string().min(1).max(200),
          bodyBase64: z.string(),
        }),
      )
      .output(supportAttachmentSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return attachmentWire(await support.attachAsOperator({ operatorId: ctx.principal!.userId, ...input }));
        } catch (err) {
          mapError(err);
        }
      }),

    /** Owner read of one attachment's metadata. */
    attachment: scopedProcedure('support:read')
      .input(supportAttachmentIdInputSchema)
      .output(supportAttachmentSchema)
      .query(async ({ ctx, input }) => {
        try {
          return attachmentWire(
            await support.attachment({ userId: ctx.principal!.userId, attachmentId: input.attachmentId, asOperator: false }),
          );
        } catch (err) {
          mapError(err);
        }
      }),

    /** Operator read. support:ops, and only an attachment on a ticket assigned to them. */
    attachmentOps: scopedProcedure('support:ops')
      .input(supportAttachmentIdInputSchema)
      .output(supportAttachmentSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return attachmentWire(
            await support.attachment({ userId: ctx.principal!.userId, attachmentId: input.attachmentId, asOperator: true }),
          );
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * The files on one ticket with their scan state. The owner reads their own; an operator reads a ticket they may see.
     * Page size is required: blank refuses `support.list_attachments_limit_unset`, never a default.
     */
    ticketAttachments: scopedProcedure('support:read')
      .input(z.object({ ticketId: z.string().guid(), limit: z.number().int().positive().max(500).optional() }))
      .output(z.array(supportAttachmentSchema))
      .query(async ({ ctx, input }) => {
        try {
          const asOperator = ctx.principal!.scopes.includes('support:ops');
          const rows = await support.listAttachments({
            userId: ctx.principal!.userId,
            ticketId: input.ticketId,
            asOperator,
            limit: input.limit,
          });
          return rows.map(attachmentWire);
        } catch (err) {
          mapError(err);
        }
      }),

    /** Owner download. Served only when the scanner said clean, always as a download with a fixed content type. */
    attachmentDownload: scopedProcedure('support:read')
      .input(supportAttachmentIdInputSchema)
      .output(supportAttachmentDownloadSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await support.attachmentDownload({
            userId: ctx.principal!.userId,
            attachmentId: input.attachmentId,
            asOperator: false,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Operator download. support:ops, and only a file on a ticket assigned to them; the same rules as the owner's. */
    attachmentDownloadOps: scopedProcedure('support:ops')
      .input(supportAttachmentIdInputSchema)
      .output(supportAttachmentDownloadSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.attachmentDownload({
            userId: ctx.principal!.userId,
            attachmentId: input.attachmentId,
            asOperator: true,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /** One vote per account per published article version. A repeat updates nothing. */
    kbFeedback: scopedProcedure('support:write')
      .input(
        z.object({
          id: z.string().min(1).max(200),
          helpful: z.boolean(),
          clientRequestId: z.string().min(1).max(200),
          /** Kept on an unhelpful vote. A request needs this and helpful false. */
          comment: z.string().max(2_000).optional(),
          /** Opens one linked request. Refused unless the vote is unhelpful and the comment is set. */
          openRequest: z.boolean().optional(),
        }),
      )
      .output(
        z.object({
          articleId: z.string(),
          version: z.number().int().positive(),
          userId: z.string().guid(),
          helpful: z.boolean(),
          /** Present only when this vote opened a request. */
          ticketId: z.string().guid().optional(),
          /** True when this account had already voted on this version; the first vote stands. */
          earlier: z.literal(true).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          await helpCentreOpen(ctx.principal);
          return await support.kbFeedback({ userId: ctx.principal!.userId, ...input, viewer: kbViewerOf(ctx.principal) });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Published articles that share a category or tag. Excludes the article itself. */
    kbRelated: publicProcedure
      .input(z.object({ id: z.string().min(1).max(200) }))
      .output(z.array(supportKbArticleSchema))
      .query(async ({ ctx, input }) => {
        try {
          await helpCentreOpen(ctx.principal);
          return await support.kbRelated({ ...input, viewer: kbViewerOf(ctx.principal) });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Stage-2 — exclusive claim; refuse steal. No money. */
    claim: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid() }))
      .output(supportTicketSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.claimForOperator({
            operatorId: ctx.principal!.userId,
            ticketId: input.ticketId,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Claim the queue's next request; an empty queue refuses with `support.claim.queue_empty`. No money. */
    claimNext: scopedProcedure('support:ops')
      .output(supportTicketSchema)
      .mutation(async ({ ctx }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.claimNext(ctx.principal!.userId);
        } catch (err) {
          mapError(err);
        }
      }),

    /** Counts across the whole queue, not one page. */
    queueMetrics: scopedProcedure('support:ops')
      .output(
        z.object({
          asOf: z.string(),
          total: z.number().int(),
          open: z.number().int(),
          pending: z.number().int(),
          onHold: z.number().int(),
          resolved: z.number().int(),
          closed: z.number().int(),
          unassigned: z.number().int(),
          claimed: z.number().int(),
        }),
      )
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return support.queueMetrics(ctx.principal!.userId);
      }),

    staffList: scopedProcedure('support:ops')
      .output(
        z.array(
          z.object({
            userId: z.string(),
            role: z.enum(['agent', 'lead']),
            appointedBy: z.string(),
            appointedAt: z.string(),
            availability: z.enum(['online', 'busy', 'offline']),
            availabilitySetAt: z.string().nullable(),
            lastHeartbeatAt: z.string().nullable(),
            /** Desk groups (teams) this member belongs to, sorted by name. */
            groups: z.array(z.object({ id: z.string(), name: z.string() })),
          }),
        ),
      )
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return support.listStaffDirectory();
      }),

    /** Says whether automatic offline is an owner value or still blank. */
    staffAvailabilityPolicy: scopedProcedure('support:ops')
      .output(z.object({ automaticOffline: z.enum(['set', 'not_set']), heartbeatWindowSeconds: z.number().int().positive().nullable() }))
      .query(({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return support.staffAvailabilityPolicy();
      }),

    /** An agent sets their own availability (omit userId); a lead may set anyone's. */
    staffSetAvailability: scopedProcedure('support:ops')
      .input(
        z.object({
          userId: z.string().guid().optional(),
          availability: z.string().max(20),
          reason: z.string().max(500).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          const actorId = ctx.principal!.userId;
          return await support.setStaffAvailability({
            actorId,
            userId: input.userId ?? actorId,
            availability: input.availability as never,
            reason: input.reason,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Own heartbeat; refused while the owner has not set the offline window. */
    staffHeartbeat: scopedProcedure('support:ops').mutation(async ({ ctx }) => {
      try {
        requireSupportOps(ctx.principal!);
        return await support.staffHeartbeat({ actorId: ctx.principal!.userId });
      } catch (err) {
        mapError(err);
      }
    }),

    staffAppoint: scopedProcedure('support:ops')
      .input(
        z.object({
          userId: z.string().guid(),
          role: z.enum(['agent', 'lead']),
          idempotencyKey: z.string().min(8).max(200),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.appointStaff({ actorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Who the ticket waits on, when the first public reply went out, and the request it follows. */
    ticketLifecycle: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid() }))
      .output(supportTicketLifecycleSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.getTicketLifecycle({ operatorId: ctx.principal!.userId, ticketId: input.ticketId });
        } catch (err) {
          mapError(err);
        }
      }),

    /** The priority and type the owner lets the caller read on their own request (SP-tickets-04). */
    myTicketProperties: scopedProcedure('support:read')
      .input(z.object({ ticketId: z.string().guid() }))
      .output(supportMyTicketPropertiesSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await support.myTicketProperties({ userId: ctx.principal!.userId, ticketId: input.ticketId });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Priority, type and labels an agent set on a ticket. Null and no labels until set. */
    ticketProperties: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid() }))
      .output(supportTicketPropertiesSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.getTicketProperties({ operatorId: ctx.principal!.userId, ticketId: input.ticketId });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * The log of priority, type and label changes on a ticket, oldest first, one entry per field changed. Staff only.
     * `limit` counts saves, newest kept: one save that changed three fields is three entries.
     */
    propertyChanges: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid(), limit: z.number().int().positive().max(500) }))
      .output(z.array(supportTicketPropertyChangeSchema))
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.listTicketPropertyChanges({ operatorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Set priority, type and labels. Values arrive as text so a bad one reaches
     * the service and is refused by name (`support.property_invalid`,
     * `support.label_invalid`) instead of a schema message.
     */
    setProperties: scopedProcedure('support:ops')
      .input(
        z.object({
          ticketId: z.string().guid(),
          priority: z.string().max(40).nullable().optional(),
          ticketType: z.string().max(40).nullable().optional(),
          labels: z.array(z.string().max(200)).max(200).optional(),
          reason: z.string().min(1).max(500).optional(),
          clientRequestId: z.string().min(1).max(200),
          /** The last trail row (`sequence`) the operator read: a newer row by someone else refuses `support.stale_ticket`. */
          expectedSequence: supportExpectedSequenceSchema.optional(),
        }),
      )
      .output(supportTicketPropertiesSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.setTicketProperties({ operatorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** What the queue header says: whether scope is restricted, and the groups this caller sees. */
    deskScope: scopedProcedure('support:ops')
      .output(
        z.object({
          restricted: z.boolean(),
          groups: z.array(z.object({ id: z.string(), name: z.string() })),
          seesAllGroups: z.boolean(),
        }),
      )
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return support.deskScopeSummary(ctx.principal!.userId);
      }),

    groupsList: scopedProcedure('support:ops')
      .output(deskGroupSchema.array())
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return support.listGroups();
      }),

    /** A lead creates a group, or renames one when groupId is given. */
    groupsSave: scopedProcedure('support:ops')
      .input(
        z.object({
          groupId: z.string().guid().optional(),
          name: z.string().trim().min(1).max(80),
          idempotencyKey: z.string().min(8).max(200),
        }),
      )
      .output(deskGroupSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.saveGroup({ actorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    groupsAddMember: scopedProcedure('support:ops')
      .input(z.object({ groupId: z.string().guid(), userId: z.string().guid() }))
      .output(deskGroupSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.addGroupMember({ actorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    groupsRemoveMember: scopedProcedure('support:ops')
      .input(z.object({ groupId: z.string().guid(), userId: z.string().guid() }))
      .output(deskGroupSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.removeGroupMember({ actorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** A lead places a ticket in a group, or takes it out with groupId null. */
    ticketSetGroup: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid(), groupId: z.string().guid().nullable() }))
      .output(z.object({ ticketId: z.string(), groupId: z.string().nullable() }))
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.setTicketGroup({ actorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** The current assignee returns the ticket to the queue. */
    unclaim: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid(), idempotencyKey: z.string().min(8).max(200) }))
      .output(supportTicketSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.unclaim({ operatorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** The batch size the owner allows for a bulk change, or `null` while it is not set. */
    bulkPolicy: scopedProcedure('support:ops')
      .output(supportBulkPolicySchema)
      .query(({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return support.bulkPolicy();
      }),

    /**
     * One change (an assignee, a status or a priority) for several requests under one batch key. Each request is changed
     * on its own and answers `changed`, `unchanged` or `refused` with its typed code; a blank cap refuses the whole batch.
     */
    bulkUpdate: scopedProcedure('support:ops')
      .input(supportBulkInputSchema)
      .output(supportBulkResultSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.bulkUpdate({ operatorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** What a merge would move and what stays on the source, read before the confirmation. Moves nothing. */
    previewMerge: scopedProcedure('support:ops')
      .input(supportMergePreviewInputSchema)
      .output(supportMergePreviewSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.previewMerge({ operatorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Fold a duplicate request into the one that stays. Irreversible; a replay of the same pair returns the stored result. */
    mergeTickets: scopedProcedure('support:ops')
      .input(supportMergeInputSchema)
      .output(supportMergeResultSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.mergeTickets({ operatorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Saved filters this operator may open, and whether the owner has set a cap. */
    viewsList: scopedProcedure('support:ops')
      .output(supportViewListSchema)
      .query(async ({ ctx }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.listDeskViews(ctx.principal!.userId);
        } catch (err) {
          mapError(err);
        }
      }),

    /** Create or replace one view. Keyed by the caller's id, the name and the revision they read. */
    viewsSave: scopedProcedure('support:ops')
      .input(supportViewSaveInputSchema)
      .output(supportViewSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.saveDeskView({ actorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    viewsDelete: scopedProcedure('support:ops')
      .input(supportViewDeleteInputSchema)
      .output(supportViewSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.deleteDeskView({ actorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** One count per visible view. It counts every match the caller may see, not the page. */
    viewsCounts: scopedProcedure('support:ops')
      .output(supportViewCountsSchema)
      .query(async ({ ctx }) => {
        try {
          requireSupportOps(ctx.principal!);
          return { counts: await support.deskViewCounts(ctx.principal!.userId) };
        } catch (err) {
          mapError(err);
        }
      }),

    /** A lead assigns or reassigns a ticket to another staff member. */
    assign: scopedProcedure('support:ops')
      .input(
        z.object({
          ticketId: z.string().guid(),
          assigneeId: z.string().guid(),
          idempotencyKey: z.string().min(8).max(200),
        }),
      )
      .output(supportTicketSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.assignTo({ operatorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),
  });
}

export type SupportRouter = ReturnType<typeof createSupportRouter>;
