import { routingProcedures } from './desk-routing-router.js';
import type { DeskRouting } from './desk-routing.js';
import { TRPCError } from '@trpc/server';
import { WithdrawalFreezes } from './withdrawal-freeze.js';
import { withdrawalFreezeProcedures } from './withdrawal-freeze-router.js';
import { MemoryLinkBook, TicketLinks } from './ticket-links.js';
import { ticketLinkProcedures } from './ticket-links-router.js';
import { guestProcedures } from './guest-router.js';
import { chatProcedures } from './chat-router.js';
import type { SupportChat } from './chat.js';
import { officialChannelProcedures } from './official-channels.js';
import type { OfficialChannelList } from '@intafaced/contracts';
import { safetyRouter } from './safety-router.js';
import { MemorySafetyBook, SafetyCases } from './safety-cases.js';
import type { GuestRequests } from './guest-requests.js';
import { z } from 'zod';
import type { SupportAttachment } from '@intafaced/contracts';
import {
  SUPPORT_CATEGORY_UNKNOWN,
  SUPPORT_CATEGORY_GUIDED,
  SUPPORT_GUIDED_CATEGORIES,
  supportTicketCategorySchema,
  kbAudienceChangesInputSchema,
  supportKbAudienceChangeListSchema,
  supportTicketSchema,
  supportViewDeleteInputSchema,
  supportViewSchema,
} from '@intafaced/contracts/support';
import { supportAttachmentIdInputSchema, supportAttachmentSchema } from '@intafaced/contracts/support-attachments';
import { supportAwaitingMineSchema } from '@intafaced/contracts/support-awaiting';
import { publicProcedure, router, scopedProcedure } from '@intafaced/contracts/trpc';
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
import { MemoryCheckBook, VerificationChecks } from './verification-checks.js';
import { verificationCheckProcedures } from './verification-checks-router.js';
import { MemoryReadGrantBook, ReadGrants } from './read-grants.js';
import { mapRequestForm, requestFormProcedures } from './request-forms-router.js';
import { MemoryKbLibraryBook, type KbLibraryBook } from './kb-library.js';
import { kbLibraryProcedures } from './kb-library-router.js';
import { kbReviewProcedures } from './kb-review-router.js';
import { kbSegmentProcedures } from './kb-segment-router.js';
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
import { supportRefusal, supportTrpcError } from './record-refusal.js';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  SUPPORT_DESK_ACCOUNT_STATE,
  SUPPORT_DESK_ASSIGN,
  SUPPORT_DESK_BULK_POLICY,
  SUPPORT_DESK_BULK_UPDATE,
  SUPPORT_DESK_CASE_FILE,
  SUPPORT_DESK_CLAIM,
  SUPPORT_DESK_CLAIM_NEXT,
  SUPPORT_DESK_ESCALATE,
  SUPPORT_DESK_GROUPS_ADD_MEMBER,
  SUPPORT_DESK_GROUPS_LIST,
  SUPPORT_DESK_GROUPS_REMOVE_MEMBER,
  SUPPORT_DESK_GROUPS_SAVE,
  SUPPORT_DESK_INTERNAL_NOTE,
  SUPPORT_DESK_LIST_KB,
  SUPPORT_DESK_MERGE,
  SUPPORT_DESK_PREVIEW_MERGE,
  SUPPORT_DESK_PROPERTY_CHANGES,
  SUPPORT_DESK_PUBLISH_KB,
  SUPPORT_DESK_RATING,
  SUPPORT_DESK_RATING_SUMMARY,
  SUPPORT_DESK_SCOPE,
  SUPPORT_DESK_SET_KB_AUDIENCE,
  SUPPORT_DESK_SET_PROPERTIES,
  SUPPORT_DESK_SET_STATUS,
  SUPPORT_DESK_STAFF_LIST,
  SUPPORT_DESK_STAFF_POLICY,
  SUPPORT_DESK_STAFF_SET_AVAILABILITY,
  SUPPORT_DESK_TICKET_LIFECYCLE,
  SUPPORT_DESK_TICKET_PROPERTIES,
  SUPPORT_DESK_UNCLAIM,
  SUPPORT_DESK_UNPUBLISH_KB,
  SUPPORT_DESK_VIEWS_COUNTS,
} from '@intafaced/contracts/support-desk-procedures';
import {
  SUPPORT_ATTACH,
  SUPPORT_ATTACHMENT_DOWNLOAD,
  SUPPORT_CATEGORIES,
  SUPPORT_CLOSE,
  SUPPORT_COMMENT,
  SUPPORT_CREATE,
  SUPPORT_CREATED_BY_REQUEST,
  SUPPORT_EVENTS,
  SUPPORT_GET,
  SUPPORT_GET_KB,
  SUPPORT_KB_FEEDBACK,
  SUPPORT_KB_RELATED,
  SUPPORT_LIST_COMMENTS,
  SUPPORT_LIST_MINE,
  SUPPORT_MY_TICKET_PROPERTIES,
  SUPPORT_RATE,
  SUPPORT_RATED_MINE,
  SUPPORT_RATING,
  SUPPORT_SEARCH_KB,
  SUPPORT_TICKET_ATTACHMENTS,
} from '@intafaced/contracts/support-customer-procedures';
import { SUPPORT_DESK_ATTACH_OPS, SUPPORT_DESK_ATTACHMENT_DOWNLOAD_OPS } from '@intafaced/contracts/support-desk-settings-procedures';
import { SLA_POLICY_STALE, SLA_TARGETS_UNSET } from './response-targets.js';
import { queueEntrySchema } from '@intafaced/contracts/support-call-schemas';
import { SUPPORT_LIST_QUEUE } from '@intafaced/contracts/support-list-queue-procedures';
import { SUPPORT_VIEWS_LIST } from '@intafaced/contracts/support-views-list-procedures';
import { SUPPORT_TICKET_CHARTS_LOOKUP } from '@intafaced/contracts/support-ticket-charts-lookup-procedures';
import { SUPPORT_VIEWS_SAVE } from '@intafaced/contracts/support-views-save-procedures';

/** The caller a scoped procedure has already checked; a missing one is refused, never assumed. */
function principalOf<P>(principal: P | null | undefined): P {
  if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED', message: userCopy('scope.denied') });
  return principal;
}

const responseTargetPolicySchema = z.object({
  firstReplyMinutes: z.number().int().positive().nullable(),
  active: z.boolean(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime().nullable(),
});

export function mapError(err: unknown): never {
  if (err instanceof SupportError) throw supportTrpcError(err);
  throw err;
}

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
  guests?: GuestRequests,
  /** The owner's `SUPPORT_KB_SEGMENT_CAP`; null (blank) refuses `support.kb_segment_cap_unset`. Never defaulted. */
  kbSegmentCap: number | null = null,
  /** The balance disclosure gate (J-support-public-20 #2). Left out, no record owner is wired and no check can be recorded. */
  checks: VerificationChecks = new VerificationChecks(new MemoryCheckBook(), support, null),
  /** The owner's official channel list (`SUPPORT_OFFICIAL_CHANNELS`); null is unpublished. */
  officialChannels: OfficialChannelList | null = null,
  /** Complaints and bereavement reports, each acknowledged once (BK-safe-03, J-bank-18 #5 #6). */
  safety: SafetyCases = new SafetyCases(new MemorySafetyBook(), support, null),
  /** Live chat (SP-chat-01). Left out, every chat door refuses `support.chat_unwired`. */
  chat?: SupportChat,
  /** Routing, capacity and skills (SP-routing-01). Left out, no routing procedure is mounted and nothing routes. */
  routing?: DeskRouting,
  /** Withdrawal freezes asked from a request (J-support-public-20 #7). Left out, no identity is wired and each ask refuses. */
  freezes: WithdrawalFreezes = new WithdrawalFreezes(support, null),
  /** A request's links to the customer's own records (J-support-public-20 #1). Left out, every link refuses unverifiable. */
  links: TicketLinks = new TicketLinks(new MemoryLinkBook(), support, null, null),
  /** The customer's grants for support to read, and the reads under them (J-support-public-20 #2). Left out, no owner is wired. */
  reads: ReadGrants = new ReadGrants({ book: new MemoryReadGrantBook(), support, linkedWithdrawals: async () => [] }),
) {
  const helpCentreOpen = helpCentreGate(helpCentre);
  return router({
    ...chatProcedures(chat, mapError),
    ...withdrawalFreezeProcedures(freezes, mapError),
    ...macroProcedures(macros),
    ...(routing ? routingProcedures(routing, support) : {}),
    ...contactProcedures(contact, support),
    ...attachmentProcedures(attachmentSettings, support),
    ...surveyProcedures(surveys, support, surveyApprovals),
    ...helpCentreProcedures(helpCentre, support),
    ...requestFormProcedures(forms, support),
    ...kbFeedbackProcedures(support, mapError, helpCentreOpen),
    ...kbLibraryProcedures(kbLibrary, support, helpCentreOpen, mapError),
    ...kbReviewProcedures(kbAuthoring, kbLibrary),
    ...guestProcedures(guests, mapError),
    ...kbSegmentProcedures(kbSegmentCap),
    ...verificationCheckProcedures(checks, reads),
    ...ticketLinkProcedures(links, mapError),
    ...officialChannelProcedures(officialChannels),
    safety: safetyRouter(safety),

    deskPolicy: publicProcedure.query(() => describeSupportDeskPolicy(internalServiceSecret ?? null)),

    kbPolicy: publicProcedure.query(() => describeKbPolicy()),

    /** The categories a person can send, where each goes, and which cannot be sent now (SP-tickets-01). */
    categories: mountRecord(
      SUPPORT_CATEGORIES,
      async () => {
        return await support.categories();
      },
      supportRefusal,
    ),

    create: mountRecord(
      SUPPORT_CREATE,
      async ({ ctx, input: wire }) => {
        // A category the service does not offer is refused by its own code, before anything else is read.
        const category = supportTicketCategorySchema.safeParse(wire.category);
        if (!category.success)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: userCopy(SUPPORT_CATEGORY_UNKNOWN),
            cause: Object.assign(new Error(SUPPORT_CATEGORY_UNKNOWN), { code: SUPPORT_CATEGORY_UNKNOWN }),
          });
        // A complaint or a bereavement report is made only through its own form, which acknowledges it once (BK-safe-03).
        if ((SUPPORT_GUIDED_CATEGORIES as readonly string[]).includes(category.data))
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: userCopy(SUPPORT_CATEGORY_GUIDED),
            cause: Object.assign(new Error(SUPPORT_CATEGORY_GUIDED), { code: SUPPORT_CATEGORY_GUIDED }),
          });
        const input = { ...wire, category: category.data };
        const userId = ctx.principal!.userId;
        // A request sent with a form is checked against the stored form before the ticket exists (SP-tickets-03). A
        // replay of a key whose ticket already exists is not refused for a form changed since: it returns that ticket,
        // and keeps the answers only if they still fit and none were kept (a crash between the two writes).
        let checked: Awaited<ReturnType<RequestForms['check']>> | null = null;
        if (input.form) {
          try {
            checked = await forms.check(input.form);
          } catch (err) {
            // Only a refusal of the answers is forgiven, and only for a key whose ticket already exists.
            if (!(err instanceof RequestFormError)) throw err;
            const prior = input.clientRequestId ? await support.createdByRequest({ userId, clientRequestId: input.clientRequestId }) : null;
            if (!prior) throw mapRequestForm(err);
          }
        }
        const { form: _form, ...ticketInput } = input;
        const ticket = await support.createTicket({ userId, ...ticketInput });
        // The answers are kept once per request; a replay that finds them kept changes nothing.
        if (checked) await forms.record(ticket.id, checked);
        loop?.markTicketCreateSuccess();
        return ticket;
      },
      supportRefusal,
    ),

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

    listMine: mountRecord(
      SUPPORT_LIST_MINE,
      async ({ ctx, input }) => {
        return await support.listMyTickets({ userId: ctx.principal!.userId, limit: input?.limit });
      },
      supportRefusal,
    ),

    /** The caller's own request a `create` key made, or null (a page whose create answer was lost reads this). */
    createdByRequest: mountRecord(
      SUPPORT_CREATED_BY_REQUEST,
      async ({ ctx, input }) => {
        return await support.createdByRequest({ userId: ctx.principal!.userId, clientRequestId: input.clientRequestId });
      },
      supportRefusal,
    ),

    /** Ids of the caller's own tickets that carry a rating. */
    ratedMine: mountRecord(
      SUPPORT_RATED_MINE,
      async ({ ctx }) => {
        return await support.ratedTicketIds(ctx.principal!.userId);
      },
      supportRefusal,
    ),

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

    get: mountRecord(
      SUPPORT_GET,
      async ({ ctx, input }) => {
        const asOperator = ctx.principal!.scopes.includes('support:ops');
        return await support.getTicket({
          userId: ctx.principal!.userId,
          ticketId: input.ticketId,
          asOperator,
        });
      },
      supportRefusal,
    ),

    comment: mountRecord(
      SUPPORT_COMMENT,
      ({ ctx, input }) => {
        const asOperator = ctx.principal.scopes.includes('support:ops');
        return support.comment({
          userId: ctx.principal.userId,
          ticketId: input.ticketId,
          body: input.body,
          asOperator,
          ...(input.clientRequestId !== undefined ? { clientRequestId: input.clientRequestId } : {}),
          ...(input.expectedSequence !== undefined ? { expectedSequence: input.expectedSequence } : {}),
        });
      },
      supportRefusal,
    ),

    /** A staff-only note (SP-tickets-05): never on the customer's thread, and it moves nothing the customer reads. */
    addInternalNote: mountRecord(
      SUPPORT_DESK_INTERNAL_NOTE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.addInternalNote({
          userId: ctx.principal.userId,
          ticketId: input.ticketId,
          body: input.body,
          clientRequestId: input.clientRequestId,
        });
      },
      supportRefusal,
    ),

    listComments: mountRecord(
      SUPPORT_LIST_COMMENTS,
      async ({ ctx, input }) => {
        const asOperator = ctx.principal!.scopes.includes('support:ops');
        return await support.listComments({
          userId: ctx.principal!.userId,
          ticketId: input.ticketId,
          asOperator,
          limit: input.limit,
        });
      },
      supportRefusal,
    ),

    setStatus: mountRecord(
      SUPPORT_DESK_SET_STATUS,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.setStatus({
          operatorId: ctx.principal.userId,
          ticketId: input.ticketId,
          status: input.status,
          note: input.note,
          ...(input.expectedSequence !== undefined ? { expectedSequence: input.expectedSequence } : {}),
        });
      },
      supportRefusal,
    ),

    /**
     * The audit trail. `support:read` — the ticket's OWNER can see what
     * happened to their own complaint, which is the point of keeping it.
     * Visibility is decided by the same owner-or-operator rule as `get`.
     */
    events: mountRecord(
      SUPPORT_EVENTS,
      async ({ ctx, input }) => {
        return await support.listTicketEvents({
          userId: ctx.principal!.userId,
          ticketId: input.ticketId,
          asOperator: ctx.principal!.scopes.includes('support:ops'),
          limit: input.limit,
        });
      },
      supportRefusal,
    ),

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
    accountState: mountRecord(
      SUPPORT_DESK_ACCOUNT_STATE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.readAccountState({ operatorId: ctx.principal.userId, ticketId: input.ticketId });
      },
      supportRefusal,
    ),

    /**
     * A customer's price alerts, their trigger history and saved desk layouts, for a ticket the agent can see
     * (C-ops-03 (a), J-charts-desk-19 #1). Read-only. The customer comes off the ticket: the input is `.strict()`, so a
     * `userId` is refused rather than silently dropped, as on `accountState`. One `charts_lookup` trail row is written
     * before anything is read; when it does not land the lookup is refused.
     */
    ticketChartsLookup: mountRecord(
      SUPPORT_TICKET_CHARTS_LOOKUP,
      async ({ ctx, input }) => {
        try {
          const principal = principalOf(ctx.principal);
          requireSupportOps(principal);
          return await support.readChartsLookup({ operatorId: principal.userId, ticketId: input.ticketId });
        } catch (err) {
          mapError(err);
        }
      },
      supportRefusal,
    ),

    /** Escalate with a case file. Refuses when nothing was read. No money. */
    escalate: mountRecord(
      SUPPORT_DESK_ESCALATE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.escalate({ operatorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    /** The case file an escalation was made against. null = never escalated. */
    caseFile: mountRecord(
      SUPPORT_DESK_CASE_FILE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.getCaseFile({ operatorId: ctx.principal.userId, ticketId: input.ticketId });
      },
      supportRefusal,
    ),

    listKb: mountRecord(
      SUPPORT_DESK_LIST_KB,
      async ({ ctx, input }) => {
        await helpCentreOpen(ctx.principal);
        return support.listKb({ limit: input?.limit, viewer: kbViewerOf(ctx.principal) });
      },
      supportRefusal,
    ),

    /** Search platform KB spine (i18n keys). Empty q → published list, then page. */
    searchKb: mountRecord(
      SUPPORT_SEARCH_KB,
      async ({ ctx, input }) => {
        await helpCentreOpen(ctx.principal);
        const found = await support.searchKb(input?.q ?? '', { limit: input?.limit, viewer: kbViewerOf(ctx.principal) });
        if (found.length > 0) loop?.markKbSearchSuccess();
        return found;
      },
      supportRefusal,
    ),

    /** Single KB article by id — omitted version is latest published; unknown version refuses by name. */
    getKb: mountRecord(
      SUPPORT_GET_KB,
      async ({ ctx, input }) => {
        await helpCentreOpen(ctx.principal);
        const article = await support.getKbArticle({ id: input.id, version: input.version }, { viewer: kbViewerOf(ctx.principal) });
        if (article) loop?.markKbGetSuccess();
        return article;
      },
      supportRefusal,
    ),

    /** Operator publish. Bumps revision. Stale baseRevision → CONFLICT. */
    publishKb: mountRecord(
      SUPPORT_DESK_PUBLISH_KB,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.publishKb(input);
      },
      supportRefusal,
    ),

    /**
     * Operator change of who may read an article (public, signed_in or staff). Stale `baseRevision` is a CONFLICT;
     * the same audience again is a no-op that writes no audit row.
     */
    setKbAudience: mountRecord(
      SUPPORT_DESK_SET_KB_AUDIENCE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.setKbAudience({ operatorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    /** The audience trail of one article, oldest first: old and new audience, revisions, who and when. */
    kbAudienceChanges: scopedProcedure('support:ops')
      .input(kbAudienceChangesInputSchema)
      .output(supportKbAudienceChangeListSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.listKbAudienceChanges(input.id);
        } catch (err) {
          mapError(err);
        }
      }),

    /** Operator unpublish. Hidden from public list/search/get. */
    unpublishKb: mountRecord(
      SUPPORT_DESK_UNPUBLISH_KB,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.unpublishKb(input);
      },
      supportRefusal,
    ),

    /** Stage-2 — prioritised operator queue (open/pending only). */
    listQueue: mountRecord(
      SUPPORT_LIST_QUEUE,
      async ({ ctx, input }) => {
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
      },
      supportRefusal,
    ),

    /** The desk's response targets (SP-sla-01): the first-reply target in minutes, or null, and whether it is on. */
    responseTargets: scopedProcedure('support:ops')
      .output(responseTargetPolicySchema)
      .query(async ({ ctx }) => {
        requireSupportOps(principalOf(ctx.principal));
        return support.responseTargets();
      }),

    /** A lead sets the first-reply target or turns it on or off, from the revision they read, with a reason. */
    responseTargetsSave: scopedProcedure('support:ops')
      .input(
        z.object({
          firstReplyMinutes: z.number().int().min(1).max(525_600).nullable().optional(),
          active: z.boolean().optional(),
          expectedRevision: z.number().int().nonnegative(),
          reason: z.string().trim().min(1).max(500),
        }),
      )
      .output(responseTargetPolicySchema)
      .mutation(async ({ ctx, input }) => {
        const principal = principalOf(ctx.principal);
        requireSupportOps(principal);
        try {
          return await support.saveResponseTargets({ actorId: principal.userId, ...input });
        } catch (err) {
          if (err instanceof SupportError && err.code === 'support.not_lead')
            throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('support.not_lead') });
          if (err instanceof SupportError && err.code === SLA_POLICY_STALE)
            throw new TRPCError({ code: 'CONFLICT', message: SLA_POLICY_STALE });
          if (err instanceof SupportError && err.code === SLA_TARGETS_UNSET)
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: SLA_TARGETS_UNSET });
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
    close: mountRecord(
      SUPPORT_CLOSE,
      async ({ ctx, input }) => {
        return await support.close({ userId: ctx.principal!.userId, ...input });
      },
      supportRefusal,
    ),

    /** Owner rating. Once per ticket, only when resolved or closed. */
    rate: mountRecord(
      SUPPORT_RATE,
      async ({ ctx, input }) => {
        return await support.rate({ userId: ctx.principal!.userId, ...input });
      },
      supportRefusal,
    ),

    /** The caller's own rating, or null when they have not rated. */
    rating: mountRecord(
      SUPPORT_RATING,
      async ({ ctx, input }) => {
        return await support.rating({ userId: ctx.principal!.userId, ticketId: input.ticketId, asOperator: false });
      },
      supportRefusal,
    ),

    /** Operator read of a rating. Requires support:ops. */
    ratingOps: mountRecord(
      SUPPORT_DESK_RATING,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.rating({ userId: ctx.principal.userId, ticketId: input.ticketId, asOperator: true });
      },
      supportRefusal,
    ),

    /** Founder summary of ratings for requests solved in a stated window. Requires support:ops. */
    ratingSummary: mountRecord(
      SUPPORT_DESK_RATING_SUMMARY,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.ratingSummary({ viewerId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    /**
     * Owner attach. Unconfigured store, scanner, or limits refuse
     * support.attachments_unconfigured and name the missing key. The answer carries the scan state:
     * a file is stored only once it is clean, and a file the scanner could not judge stays held.
     */
    attach: mountRecord(
      SUPPORT_ATTACH,
      async ({ ctx, input }) => {
        return attachmentWire(await support.attach({ userId: ctx.principal!.userId, ...input }));
      },
      supportRefusal,
    ),

    /**
     * Operator attach, for the operator the ticket is assigned to. The file is the ticket owner's and names the operator
     * in `uploadedBy`. Limits, scanner and store are the owner attach's; another operator's ticket answers like none.
     */
    attachOps: mountRecord(
      SUPPORT_DESK_ATTACH_OPS,
      async ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return attachmentWire(await support.attachAsOperator({ operatorId: ctx.principal.userId, ...input }));
      },
      supportRefusal,
    ),

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
    ticketAttachments: mountRecord(
      SUPPORT_TICKET_ATTACHMENTS,
      async ({ ctx, input }) => {
        const asOperator = ctx.principal!.scopes.includes('support:ops');
        const rows = await support.listAttachments({
          userId: ctx.principal!.userId,
          ticketId: input.ticketId,
          asOperator,
          limit: input.limit,
        });
        return rows.map(attachmentWire);
      },
      supportRefusal,
    ),

    /** Owner download. Served only when the scanner said clean, always as a download with a fixed content type. */
    attachmentDownload: mountRecord(
      SUPPORT_ATTACHMENT_DOWNLOAD,
      async ({ ctx, input }) => {
        return await support.attachmentDownload({
          userId: ctx.principal!.userId,
          attachmentId: input.attachmentId,
          asOperator: false,
        });
      },
      supportRefusal,
    ),

    /** Operator download. support:ops, and only a file on a ticket assigned to them; the same rules as the owner's. */
    attachmentDownloadOps: mountRecord(
      SUPPORT_DESK_ATTACHMENT_DOWNLOAD_OPS,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.attachmentDownload({ userId: ctx.principal.userId, attachmentId: input.attachmentId, asOperator: true });
      },
      supportRefusal,
    ),

    /** One vote per account per published article version. A repeat updates nothing. */
    kbFeedback: mountRecord(
      SUPPORT_KB_FEEDBACK,
      async ({ ctx, input }) => {
        await helpCentreOpen(ctx.principal);
        return await support.kbFeedback({ userId: ctx.principal!.userId, ...input, viewer: kbViewerOf(ctx.principal) });
      },
      supportRefusal,
    ),

    /** Published articles that share a category or tag. Excludes the article itself. */
    kbRelated: mountRecord(
      SUPPORT_KB_RELATED,
      async ({ ctx, input }) => {
        await helpCentreOpen(ctx.principal);
        return await support.kbRelated({ ...input, viewer: kbViewerOf(ctx.principal) });
      },
      supportRefusal,
    ),

    /** Stage-2 — exclusive claim; refuse steal. No money. */
    claim: mountRecord(
      SUPPORT_DESK_CLAIM,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.claimForOperator({ operatorId: ctx.principal.userId, ticketId: input.ticketId });
      },
      supportRefusal,
    ),

    /** Claim the queue's next request; an empty queue refuses with `support.claim.queue_empty`. No money. */
    claimNext: mountRecord(
      SUPPORT_DESK_CLAIM_NEXT,
      ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return support.claimNext(ctx.principal.userId);
      },
      supportRefusal,
    ),

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

    staffList: mountRecord(
      SUPPORT_DESK_STAFF_LIST,
      ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return support.listStaffDirectory();
      },
      supportRefusal,
    ),

    /** Says whether automatic offline is an owner value or still blank. */
    staffAvailabilityPolicy: mountRecord(
      SUPPORT_DESK_STAFF_POLICY,
      ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return support.staffAvailabilityPolicy();
      },
      supportRefusal,
    ),

    /** An agent sets their own availability (omit userId); a lead may set anyone's. */
    staffSetAvailability: mountRecord(
      SUPPORT_DESK_STAFF_SET_AVAILABILITY,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        const actorId = ctx.principal.userId;
        return support.setStaffAvailability({
          actorId,
          userId: input.userId ?? actorId,
          availability: input.availability as never,
          reason: input.reason,
        });
      },
      supportRefusal,
    ),

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
    ticketLifecycle: mountRecord(
      SUPPORT_DESK_TICKET_LIFECYCLE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.getTicketLifecycle({ operatorId: ctx.principal.userId, ticketId: input.ticketId });
      },
      supportRefusal,
    ),

    /** The priority and type the owner lets the caller read on their own request (SP-tickets-04). */
    myTicketProperties: mountRecord(
      SUPPORT_MY_TICKET_PROPERTIES,
      async ({ ctx, input }) => {
        return await support.myTicketProperties({ userId: ctx.principal!.userId, ticketId: input.ticketId });
      },
      supportRefusal,
    ),

    /** Priority, type and labels an agent set on a ticket. Null and no labels until set. */
    ticketProperties: mountRecord(
      SUPPORT_DESK_TICKET_PROPERTIES,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.getTicketProperties({ operatorId: ctx.principal.userId, ticketId: input.ticketId });
      },
      supportRefusal,
    ),

    /**
     * The log of priority, type and label changes on a ticket, oldest first, one entry per field changed. Staff only.
     * `limit` counts saves, newest kept: one save that changed three fields is three entries.
     */
    propertyChanges: mountRecord(
      SUPPORT_DESK_PROPERTY_CHANGES,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.listTicketPropertyChanges({ operatorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    /**
     * Set priority, type and labels. Values arrive as text so a bad one reaches
     * the service and is refused by name (`support.property_invalid`,
     * `support.label_invalid`) instead of a schema message.
     */
    setProperties: mountRecord(
      SUPPORT_DESK_SET_PROPERTIES,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.setTicketProperties({ operatorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    /** What the queue header says: whether scope is restricted, and the groups this caller sees. */
    deskScope: mountRecord(
      SUPPORT_DESK_SCOPE,
      ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return support.deskScopeSummary(ctx.principal.userId);
      },
      supportRefusal,
    ),

    groupsList: mountRecord(
      SUPPORT_DESK_GROUPS_LIST,
      ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return support.listGroups();
      },
      supportRefusal,
    ),

    /** A lead creates a group, or renames one when groupId is given. */
    groupsSave: mountRecord(
      SUPPORT_DESK_GROUPS_SAVE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.saveGroup({ actorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    groupsAddMember: mountRecord(
      SUPPORT_DESK_GROUPS_ADD_MEMBER,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.addGroupMember({ actorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    groupsRemoveMember: mountRecord(
      SUPPORT_DESK_GROUPS_REMOVE_MEMBER,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.removeGroupMember({ actorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    /** A lead places a ticket in a group, or takes it out with groupId null. */
    ticketSetGroup: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid(), groupId: z.string().guid().nullable() }))
      .output(z.object({ ticketId: z.string(), groupId: z.string().nullable() }))
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          const placed = await support.setTicketGroup({ actorId: ctx.principal!.userId, ...input });
          // A request placed in a routed group goes to its next agent now (SP-routing-01); routing off or unset does nothing.
          // The group change has committed; a routing pass that fails after it is logged and left to the next pass or
          // sweep, never reported as a failed group change.
          if (routing && placed.groupId !== null)
            await routing
              .route(placed.ticketId)
              .catch((err: unknown) => console.error('svc-support: routing after a group change failed', err));
          return placed;
        } catch (err) {
          mapError(err);
        }
      }),

    /** The current assignee returns the ticket to the queue. */
    unclaim: mountRecord(
      SUPPORT_DESK_UNCLAIM,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.unclaim({ operatorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    /** The batch size the owner allows for a bulk change, or `null` while it is not set. */
    bulkPolicy: mountRecord(
      SUPPORT_DESK_BULK_POLICY,
      ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return support.bulkPolicy();
      },
      supportRefusal,
    ),

    /**
     * One change (an assignee, a status or a priority) for several requests under one batch key. Each request is changed
     * on its own and answers `changed`, `unchanged` or `refused` with its typed code; a blank cap refuses the whole batch.
     */
    bulkUpdate: mountRecord(
      SUPPORT_DESK_BULK_UPDATE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.bulkUpdate({ operatorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    /** What a merge would move and what stays on the source, read before the confirmation. Moves nothing. */
    previewMerge: mountRecord(
      SUPPORT_DESK_PREVIEW_MERGE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.previewMerge({ operatorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    /** Fold a duplicate request into the one that stays. Irreversible; a replay of the same pair returns the stored result. */
    mergeTickets: mountRecord(
      SUPPORT_DESK_MERGE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.mergeTickets({ operatorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),

    /** Saved filters this operator may open, and whether the owner has set a cap. */
    viewsList: mountRecord(
      SUPPORT_VIEWS_LIST,
      async ({ ctx }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.listDeskViews(ctx.principal!.userId);
        } catch (err) {
          mapError(err);
        }
      },
      supportRefusal,
    ),

    /** Create or replace one view. Keyed by the caller's id, the name and the revision they read. */
    viewsSave: mountRecord(
      SUPPORT_VIEWS_SAVE,
      async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.saveDeskView({ actorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      },
      supportRefusal,
    ),

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
    viewsCounts: mountRecord(
      SUPPORT_DESK_VIEWS_COUNTS,
      async ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return { counts: await support.deskViewCounts(ctx.principal.userId) };
      },
      supportRefusal,
    ),

    /** A lead assigns or reassigns a ticket to another staff member. */
    assign: mountRecord(
      SUPPORT_DESK_ASSIGN,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return support.assignTo({ operatorId: ctx.principal.userId, ...input });
      },
      supportRefusal,
    ),
  });
}

export type SupportRouter = ReturnType<typeof createSupportRouter>;
