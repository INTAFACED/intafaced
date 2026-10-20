import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import {
  createTicketInputSchema,
  escalateTicketInputSchema,
  getKbArticleInputSchema,
  setKbAudienceInputSchema,
  type SupportAttachment,
  type SupportKbViewer,
  publicProcedure,
  router,
  scopedProcedure,
  supportAccountGroundingSchema,
  supportAttachmentDownloadSchema,
  supportAttachmentIdInputSchema,
  supportAttachmentSchema,
  supportCaseFileSchema,
  supportCommentSchema,
  supportKbArticleSchema,
  supportTicketEventSchema,
  supportAwaitingMineSchema,
  supportTicketLifecycleSchema,
  supportTicketPropertiesSchema,
  supportTicketSchema,
  supportTicketStatusSchema,
} from '@intafaced/contracts';
import { MemoryContactBook, type ContactBook } from './contact-channels.js';
import { contactProcedures } from './contact-router.js';
import type { AttachmentMeta } from './store.js';
import { attachmentProcedures } from './attachment-router.js';
import { MemoryAttachmentSettingsBook, type AttachmentSettingsBook } from './attachment-settings.js';
import { describeSupportDeskPolicy } from './desk-policy.js';
import { describeKbPolicy } from './kb-policy.js';
import { SupportError, SupportService, requireSupportOps } from './support-service.js';
import type { TicketKbLoopObserver } from './ticket-kb-loop-observation.js';
import { ticketOrderReadSchema } from './ticket-order.js';
import { userCopy } from './user-copy.js';

const queueEntrySchema = z.object({
  ticketId: z.string().uuid(),
  userId: z.string().uuid(),
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

function mapError(err: unknown): never {
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
      err.code === 'support.rate_status_refused' ||
      err.code === 'support.attachment_scan_refused' ||
      err.code === 'support.attachment_count_unset' ||
      err.code === 'support.attachment_scan_unknown' ||
      err.code === 'support.attachment_count_reached' ||
      err.code === 'support.attachment_too_large'
    ) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
    }
    if (err.code === 'support.not_lead' || err.code === 'support.not_staff' || err.code === 'support.release.not_assignee') {
      throw new TRPCError({ code: 'FORBIDDEN', message });
    }
    if (
      err.code === 'support.idempotency_conflict' ||
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

/**
 * The reader of a help door, from the signed principal and nothing else. A visitor has no principal;
 * the desk is a `support:ops` principal. Never read from the request body.
 */
function kbViewerOf(principal: Principal | null | undefined): SupportKbViewer {
  return { signedIn: Boolean(principal), staff: Boolean(principal?.scopes.includes('support:ops')) };
}

/** The wire form of a stored file: the scan state is public, the store key is not. */
function attachmentWire(meta: AttachmentMeta): SupportAttachment {
  const { id, ticketId, ownerId, contentType, byteLength, scanState, createdAt } = meta;
  // No operator uploads yet: every file is its owner's. The service PR that adds agent upload stores and reads the real value.
  return { id, ticketId, ownerId, contentType, byteLength, scanState, uploadedBy: null, createdAt };
}

export function createSupportRouter(
  support: SupportService,
  loop?: TicketKbLoopObserver,
  internalServiceSecret?: string | null,
  scope?: DeskScopeReader,
  contact: ContactBook = new MemoryContactBook(),
  attachmentSettings: AttachmentSettingsBook = new MemoryAttachmentSettingsBook(),
) {
  return router({
    ...contactProcedures(contact, support),
    ...attachmentProcedures(attachmentSettings, support),

    deskPolicy: publicProcedure.query(() => describeSupportDeskPolicy(internalServiceSecret ?? null)),

    kbPolicy: publicProcedure.query(() => describeKbPolicy()),

    create: scopedProcedure('support:write')
      .input(createTicketInputSchema)
      .output(supportTicketSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          const ticket = await support.createTicket({ userId: ctx.principal!.userId, ...input });
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

    /** Ids of the caller's own tickets that carry a rating. */
    ratedMine: scopedProcedure('support:read')
      .output(z.array(z.string().uuid()))
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
          })
          .optional(),
      )
      .output(z.array(supportTicketSchema))
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          if (scope && (await scope.deskIsRestricted())) {
            return await scope.listAllTicketsInScope({ limit: input?.limit, viewerId: ctx.principal!.userId });
          }
          return await support.listAllTickets({ limit: input?.limit });
        } catch (err) {
          mapError(err);
        }
      }),

    get: scopedProcedure('support:read')
      .input(z.object({ ticketId: z.string().uuid() }))
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
      .input(z.object({ ticketId: z.string().uuid(), body: z.string().min(1).max(10_000) }))
      .output(supportCommentSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          const asOperator = ctx.principal!.scopes.includes('support:ops');
          return await support.comment({
            userId: ctx.principal!.userId,
            ticketId: input.ticketId,
            body: input.body,
            asOperator,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    listComments: scopedProcedure('support:read')
      .input(
        z.object({
          ticketId: z.string().uuid(),
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
          ticketId: z.string().uuid(),
          status: supportTicketStatusSchema,
          /** Optional short reason, recorded on the trail row. Not required, so
           *  no existing caller breaks; recorded when supplied. */
          note: z.string().min(1).max(500).optional(),
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
          ticketId: z.string().uuid(),
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
      .input(z.object({ ticketId: z.string().uuid(), orderId: z.string().uuid() }).strict())
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
      .input(z.object({ ticketId: z.string().uuid() }).strict())
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
      .input(z.object({ ticketId: z.string().uuid() }))
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
          })
          .optional(),
      )
      .output(queueResultSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          const q = input?.label
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
          ticketId: z.string().uuid().optional(),
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
      .input(z.object({ ticketId: z.string().uuid(), clientRequestId: z.string().min(1).max(200) }))
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
          ticketId: z.string().uuid(),
          score: z.number().int(),
          note: z.string().max(500).optional(),
          clientRequestId: z.string().min(1).max(200),
        }),
      )
      .output(
        z.object({
          ticketId: z.string().uuid(),
          userId: z.string().uuid(),
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
      .input(z.object({ ticketId: z.string().uuid() }))
      .output(
        z
          .object({
            ticketId: z.string().uuid(),
            userId: z.string().uuid(),
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
      .input(z.object({ ticketId: z.string().uuid() }))
      .output(
        z
          .object({
            ticketId: z.string().uuid(),
            userId: z.string().uuid(),
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
          ticketId: z.string().uuid(),
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
      .input(z.object({ ticketId: z.string().uuid(), limit: z.number().int().positive().max(500).optional() }))
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
        }),
      )
      .output(
        z.object({
          articleId: z.string(),
          version: z.number().int().positive(),
          userId: z.string().uuid(),
          helpful: z.boolean(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
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
          return await support.kbRelated({ ...input, viewer: kbViewerOf(ctx.principal) });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Stage-2 — exclusive claim; refuse steal. No money. */
    claim: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().uuid() }))
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
          }),
        ),
      )
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return support.listStaff();
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
          userId: z.string().uuid().optional(),
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
          userId: z.string().uuid(),
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
      .input(z.object({ ticketId: z.string().uuid() }))
      .output(supportTicketLifecycleSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.getTicketLifecycle({ operatorId: ctx.principal!.userId, ticketId: input.ticketId });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Priority, type and labels an agent set on a ticket. Null and no labels until set. */
    ticketProperties: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().uuid() }))
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
     * Set priority, type and labels. Values arrive as text so a bad one reaches
     * the service and is refused by name (`support.property_invalid`,
     * `support.label_invalid`) instead of a schema message.
     */
    setProperties: scopedProcedure('support:ops')
      .input(
        z.object({
          ticketId: z.string().uuid(),
          priority: z.string().max(40).nullable().optional(),
          ticketType: z.string().max(40).nullable().optional(),
          labels: z.array(z.string().max(200)).max(200).optional(),
          reason: z.string().min(1).max(500).optional(),
          clientRequestId: z.string().min(1).max(200),
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
          groupId: z.string().uuid().optional(),
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
      .input(z.object({ groupId: z.string().uuid(), userId: z.string().uuid() }))
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
      .input(z.object({ groupId: z.string().uuid(), userId: z.string().uuid() }))
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
      .input(z.object({ ticketId: z.string().uuid(), groupId: z.string().uuid().nullable() }))
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
      .input(z.object({ ticketId: z.string().uuid(), idempotencyKey: z.string().min(8).max(200) }))
      .output(supportTicketSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.unclaim({ operatorId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** A lead assigns or reassigns a ticket to another staff member. */
    assign: scopedProcedure('support:ops')
      .input(
        z.object({
          ticketId: z.string().uuid(),
          assigneeId: z.string().uuid(),
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
