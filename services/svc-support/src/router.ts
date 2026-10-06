import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  createTicketInputSchema,
  escalateTicketInputSchema,
  getKbArticleInputSchema,
  publicProcedure,
  router,
  scopedProcedure,
  supportAccountGroundingSchema,
  supportCaseFileSchema,
  supportCommentSchema,
  supportKbArticleSchema,
  supportTicketEventSchema,
  supportTicketSchema,
  supportTicketStatusSchema,
} from '@intafaced/contracts';
import { describeSupportDeskPolicy } from './desk-policy.js';
import { describeKbPolicy } from './kb-policy.js';
import { PUBLIC_HELP_NOT_SERVED, SupportError, SupportService, requireSupportOps } from './support-service.js';
import type { TicketKbLoopObserver } from './ticket-kb-loop-observation.js';
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
    const message = userCopy(err.code);
    if (err.code === 'support.not_found' || err.code === 'support.claim.not_found') {
      throw new TRPCError({ code: 'NOT_FOUND', message });
    }
    if (err.code === 'support.claim.already_claimed' || err.code === 'support.kb.revision_stale') {
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
      err.code === 'support.settle.refused' ||
      err.code === PUBLIC_HELP_NOT_SERVED ||
      // listQueue / listAll / listMine / listComments / events / listKb / searchKb page size unpublished. Blank is not 100.
      err.code === 'support.queue_list_limit_unset' ||
      err.code === 'support.list_all_limit_unset' ||
      err.code === 'support.list_mine_limit_unset' ||
      err.code === 'support.list_comments_limit_unset' ||
      err.code === 'support.list_events_limit_unset' ||
      err.code === 'support.list_kb_limit_unset'
    ) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message });
  }
  throw err;
}

export function createSupportRouter(support: SupportService, loop?: TicketKbLoopObserver, internalServiceSecret?: string | null) {
  return router({
    deskPolicy: publicProcedure.query(() => describeSupportDeskPolicy(internalServiceSecret ?? null)),

    kbPolicy: publicProcedure.query(() => describeKbPolicy()),

    /**
     * Public help is not this room. The refusal names the missing article.
     * The slot stays empty. Nothing here becomes an answer.
     */
    publicHelp: publicProcedure
      .input(
        z.object({
          articleId: z.string().min(1).max(200),
          question: z.string().max(10_000).optional(),
        }),
      )
      .query(async ({ input }) => {
        try {
          return await support.publicHelpArticle({ articleId: input.articleId, question: input.question });
        } catch (err) {
          mapError(err);
        }
      }),

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
      .query(async ({ input }) => {
        try {
          return await support.listKb({ limit: input?.limit });
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
      .query(async ({ input }) => {
        try {
          const found = await support.searchKb(input?.q ?? '', { limit: input?.limit });
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
      .query(async ({ input }) => {
        try {
          const article = await support.getKbArticle({ id: input.id, version: input.version });
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
          })
          .optional(),
      )
      .output(queueResultSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          const q = await support.listOperatorQueue({ limit: input?.limit });
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
        return support.peekNext();
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
  });
}

export type SupportRouter = ReturnType<typeof createSupportRouter>;
