import 'server-only';
import { createHash } from 'node:crypto';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom } from '@/lib/desk/part';
import { NOTIFY, anyData, loadPublishApprovals, reply } from './incidents-server';
import {
  readAnnouncements,
  readAudiences,
  readCategories,
  type AnnouncementDraftInput,
  type NoticeCategory,
  type NoticesDeskView,
} from './notices-model';

/**
 * The announcement desk as the signed-in founder. svc-notify holds the announcements (`notify.operatorNotices`, drafts
 * included) and takes drafts and publishes on the notice board (`notify.draftNotice` and the same four-eyes publish as
 * incidents). The category list is on the status page definition (`statusPage.definition`, `statusPage.configure`); who
 * an announcement can be for is `notify.noticeAudiences`.
 */

const LIST_LIMIT = 50;

export async function loadNoticesDesk(ctx: FounderCallContext): Promise<NoticesDeskView> {
  const [announcements, categories, audiences, approvals] = await Promise.all([
    founderCall(ctx, 'notify', 'notify.operatorNotices', 'GET', { kind: 'announcement', limit: LIST_LIMIT }, readAnnouncements),
    founderCall(ctx, 'notify', 'statusPage.definition', 'GET', undefined, readCategories),
    founderCall(ctx, 'notify', 'notify.noticeAudiences', 'GET', undefined, readAudiences),
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
    await founderCall(
      ctx,
      'notify',
      'notify.draftNotice',
      'POST',
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
    await founderCall(
      ctx,
      'notify',
      'statusPage.configure',
      'POST',
      { noticeCategories: input.list, expectedRevision: input.expectedRevision, reason: input.reason.trim() },
      anyData,
    ),
    input.list === null ? 'categories cleared' : 'categories saved',
  );
}
