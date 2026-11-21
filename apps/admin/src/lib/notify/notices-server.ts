import 'server-only';
import { createHash } from 'node:crypto';
import { type FounderCallContext, partFrom, founderRecordRead } from '@/lib/desk';
import { NOTIFY, anyData, loadPublishApprovals, reply } from './incidents-server';
import {
  readAnnouncements,
  readAudiences,
  readCategories,
  type AnnouncementDraftInput,
  type NoticeCategory,
  type NoticesDeskView,
} from './notices-model';
import { NOTIFY_OPERATOR_NOTICES, NOTIFY_DRAFT_NOTICE, NOTIFY_NOTICE_AUDIENCES } from '@intafaced/contracts/notify-notify-procedures';
import { NOTIFY_STATUS_PAGE_DEFINITION, NOTIFY_STATUS_PAGE_CONFIGURE } from '@intafaced/contracts/notify-status-page-procedures';

/**
 * The announcement desk as the signed-in founder. svc-notify holds the announcements (`notify.operatorNotices`, drafts
 * included) and takes drafts and publishes on the notice board (`notify.draftNotice` and the same four-eyes publish as
 * incidents). The category list is on the status page definition (`statusPage.definition`, `statusPage.configure`); who
 * an announcement can be for is `notify.noticeAudiences`.
 */

const LIST_LIMIT = 50;

export async function loadNoticesDesk(ctx: FounderCallContext): Promise<NoticesDeskView> {
  const [announcements, categories, audiences, approvals] = await Promise.all([
    founderRecordRead(ctx, NOTIFY_OPERATOR_NOTICES, { kind: 'announcement', limit: LIST_LIMIT }, readAnnouncements),
    founderRecordRead(ctx, NOTIFY_STATUS_PAGE_DEFINITION, undefined, readCategories),
    founderRecordRead(ctx, NOTIFY_NOTICE_AUDIENCES, undefined, readAudiences),
    loadPublishApprovals(ctx),
  ]);
  return {
    announcements: partFrom(announcements, (d) => d, NOTIFY),
    categories: partFrom(categories, (d) => d, NOTIFY),
    audiences: partFrom(audiences, (d) => d, NOTIFY),
    approvals,
    me: ctx.session.userId,
    asOf: new Date().toISOString(),
  };
}

/**
 * The draft's key is its content and the newest announcement the founder saw when writing it (`basis`): a lost reply
 * sent again finds the same draft, while the same words written again after the desk moved on are a new draft.
 */
export function announcementDraftKey(founder: string, input: AnnouncementDraftInput & { basis: string | null }): string {
  // An announcement for everyone keeps the key it had before audiences, so a lost reply sent again finds its draft.
  const fields = [
    input.basis,
    input.title.trim(),
    input.body.trim(),
    input.category,
    ...(input.audience === 'everyone' ? [] : [input.audience]),
  ];
  return `announcement-draft:${createHash('sha256')
    .update(JSON.stringify([founder, fields]))
    .digest('hex')
    .slice(0, 48)}`;
}

export async function draftAnnouncement(ctx: FounderCallContext, input: AnnouncementDraftInput & { basis: string | null }) {
  return reply(
    await founderRecordRead(
      ctx,
      NOTIFY_DRAFT_NOTICE,
      {
        kind: 'announcement',
        title: input.title.trim(),
        body: input.body.trim(),
        category: input.category,
        audience: input.audience,
        clientRequestId: announcementDraftKey(ctx.session.userId, input),
      },
      anyData,
    ),
    'drafted',
  );
}

/** The whole category list (null clears it), from the revision the founder read, with why. */
export async function setCategories(
  ctx: FounderCallContext,
  input: { list: readonly NoticeCategory[] | null; expectedRevision: number; reason: string },
) {
  return reply(
    await founderRecordRead(
      ctx,
      NOTIFY_STATUS_PAGE_CONFIGURE,
      {
        noticeCategories: input.list === null ? null : [...input.list],
        expectedRevision: input.expectedRevision,
        reason: input.reason.trim(),
      },
      anyData,
    ),
    input.list === null ? 'categories cleared' : 'categories saved',
  );
}
