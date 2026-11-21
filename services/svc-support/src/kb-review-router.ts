import { TRPCError } from '@trpc/server';
import {
  SUPPORT_KB_DRAFT_UNKNOWN,
  SUPPORT_KB_NOT_APPROVED,
  SUPPORT_KB_NOT_IN_REVIEW,
  SUPPORT_KB_SAME_OPERATOR,
  SUPPORT_KB_SECTION_UNKNOWN,
  SUPPORT_KB_TEMPLATE_STALE,
} from '@intafaced/contracts';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  SUPPORT_DESK_KB_APPROVE,
  SUPPORT_DESK_KB_DRAFT,
  SUPPORT_DESK_KB_HISTORY,
  SUPPORT_DESK_KB_PUBLISH_DRAFT,
  SUPPORT_DESK_KB_SAVE_DRAFT,
  SUPPORT_DESK_KB_SAVE_TEMPLATE,
  SUPPORT_DESK_KB_SEND_BACK,
  SUPPORT_DESK_KB_SUBMIT_FOR_REVIEW,
  SUPPORT_DESK_KB_TEMPLATES,
} from '@intafaced/contracts/support-desk-settings-procedures';
import { KbAuthoring, KbAuthoringError, SUPPORT_KB_REVISION_STALE } from './kb-authoring.js';
import { requireSupportOps } from './support-service.js';
import type { KbLibraryBook } from './kb-library.js';
import { supportRefusal } from './record-refusal.js';

const STATUS: Readonly<Record<string, TRPCError['code']>> = {
  [SUPPORT_KB_DRAFT_UNKNOWN]: 'NOT_FOUND',
  [SUPPORT_KB_SAME_OPERATOR]: 'FORBIDDEN',
  [SUPPORT_KB_NOT_IN_REVIEW]: 'PRECONDITION_FAILED',
  [SUPPORT_KB_NOT_APPROVED]: 'PRECONDITION_FAILED',
  'support.kb_already_in_review': 'PRECONDITION_FAILED',
  'support.kb_section_unknown': 'PRECONDITION_FAILED',
  [SUPPORT_KB_REVISION_STALE]: 'CONFLICT',
  [SUPPORT_KB_TEMPLATE_STALE]: 'CONFLICT',
};

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof KbAuthoringError) throw new TRPCError({ code: STATUS[err.code] ?? 'BAD_REQUEST', message: err.code, cause: err });
    throw err;
  }
}

/**
 * Writing, reviewing and publishing help articles (SP-kb-01, SP-kb-02), for the support desk only. The author is the
 * signed-in operator, never a field of the request, so the second-person rule cannot be talked around.
 */
export function kbReviewProcedures(authoring: KbAuthoring, library: KbLibraryBook) {
  // A clear refusal for a section that is missing or retired; the store checks it again under a lock where it writes.
  const openSection = async (sectionId: string) => {
    const section = await library.section(sectionId);
    const category = section && !section.retired ? (await library.categories()).find((c) => c.id === section.categoryId) : null;
    if (!category || category.retired) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: SUPPORT_KB_SECTION_UNKNOWN });
  };
  return {
    kbSaveDraft: mountRecord(
      SUPPORT_DESK_KB_SAVE_DRAFT,
      async ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        await openSection(input.sectionId);
        return run(() => authoring.saveDraft(ctx.principal.userId, input));
      },
      supportRefusal,
    ),

    kbDraft: mountRecord(
      SUPPORT_DESK_KB_DRAFT,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return run(() => authoring.draft(input.id, input.revision));
      },
      supportRefusal,
    ),

    kbHistory: mountRecord(
      SUPPORT_DESK_KB_HISTORY,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return run(() => authoring.history(input.id));
      },
      supportRefusal,
    ),

    kbSubmitForReview: mountRecord(
      SUPPORT_DESK_KB_SUBMIT_FOR_REVIEW,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return run(() => authoring.submit(ctx.principal.userId, input));
      },
      supportRefusal,
    ),

    kbApprove: mountRecord(
      SUPPORT_DESK_KB_APPROVE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return run(() => authoring.approve(ctx.principal.userId, input));
      },
      supportRefusal,
    ),

    kbSendBack: mountRecord(
      SUPPORT_DESK_KB_SEND_BACK,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return run(() => authoring.sendBack(ctx.principal.userId, input));
      },
      supportRefusal,
    ),

    kbPublishDraft: mountRecord(
      SUPPORT_DESK_KB_PUBLISH_DRAFT,
      async ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        await openSection((await run(() => authoring.draft(input.id, input.revision))).sectionId);
        return run(() => authoring.publish(ctx.principal.userId, input));
      },
      supportRefusal,
    ),

    kbTemplates: mountRecord(
      SUPPORT_DESK_KB_TEMPLATES,
      ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return authoring.listTemplates();
      },
      supportRefusal,
    ),

    kbSaveTemplate: mountRecord(
      SUPPORT_DESK_KB_SAVE_TEMPLATE,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return run(() => authoring.saveTemplate(ctx.principal.userId, input));
      },
      supportRefusal,
    ),
  };
}
