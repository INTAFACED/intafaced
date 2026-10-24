import 'server-only';
import { createHash } from 'node:crypto';
import {
  ANNOUNCEMENT_STORAGE_UNCONFIGURED,
  announcementWriteOutputSchema,
  type AnnouncementAction,
  type AnnouncementKind,
  type AnnouncementWriteOutput,
} from '@intafaced/contracts/ops-console-announcements';
import { founderCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { opsReadOf } from '@/lib/desk/ops-read';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import {
  readActiveAnnouncement,
  readAnnouncementsList,
  type ActiveAnnouncementView,
  type AnnouncementDeskReply,
  type AnnouncementsView,
} from './model';

/** The banner read sits in front of every page, so a hung svc-ops costs a page this much at most (as maintenance mode). */
export const ANNOUNCEMENT_READ_TIMEOUT_MS = 2_000;

const viewOf = <T>(result: FounderCallResult<T>) => opsReadOf(result, ANNOUNCEMENT_STORAGE_UNCONFIGURED, 'announcements');

/** svc-ops `announcements.active` as the signed-in founder: the one announcement showing now. Never throws. */
export async function loadActiveAnnouncement(ctx: FounderCallContext): Promise<ActiveAnnouncementView> {
  return viewOf(
    await founderCall(ctx, 'ops', 'announcements.active', 'GET', undefined, readActiveAnnouncement, {
      timeoutMs: ANNOUNCEMENT_READ_TIMEOUT_MS,
    }),
  );
}

/** svc-ops `announcements.list`: the newest announcements, drafts and withdrawn ones too, and the one showing now. */
export async function loadAnnouncements(ctx: FounderCallContext): Promise<AnnouncementsView> {
  return viewOf(await founderCall(ctx, 'ops', 'announcements.list', 'GET', undefined, readAnnouncementsList));
}

export interface AnnouncementContent {
  readonly kind: AnnouncementKind;
  readonly title: string;
  readonly body: string;
  readonly action: AnnouncementAction;
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * The save's business key: the founder, the content, whether it is published at once, and the newest announcement they saw
 * (`basis`). A lost reply sent again finds the same announcement; the same words written again after the desk moved on are
 * a new one.
 */
export function announcementKey(founder: string, basis: string | null, content: AnnouncementContent, publish: boolean): string {
  const fields = [basis, content.kind, content.title, content.body, content.action, content.startsAt, content.endsAt, publish];
  return `announcement:${createHash('sha256')
    .update(JSON.stringify([founder, fields]))
    .digest('hex')
    .slice(0, 48)}`;
}

const parseWrite = (raw: unknown): AnnouncementWriteOutput | null => {
  const parsed = announcementWriteOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

function reply(result: FounderCallResult<AnnouncementWriteOutput>, done: (out: AnnouncementWriteOutput) => string) {
  const refused = (code: string | null, status: number, uncertain = false): { status: number; reply: AnnouncementDeskReply } => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return { status: 200, reply: { ok: true, what: done(result.data) } as AnnouncementDeskReply };
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403);
    case 'not_built':
      return refused('not_built', 501);
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      return refused(null, 502, true);
  }
}

export async function saveAnnouncement(ctx: FounderCallContext, basis: string | null, content: AnnouncementContent, publish: boolean) {
  const key = announcementKey(ctx.session.userId, basis, content, publish);
  return reply(await founderCall(ctx, 'ops', 'announcements.save', 'POST', { key, ...content, publish }, parseWrite), (out) =>
    out.outcome === 'replayed'
      ? 'this announcement was already saved'
      : out.announcement.status === 'published'
        ? 'announcement published'
        : 'draft saved',
  );
}

export async function changeAnnouncement(ctx: FounderCallContext, id: string, op: 'publish' | 'withdraw') {
  return reply(await founderCall(ctx, 'ops', 'announcements.change', 'POST', { id, op }, parseWrite), (out) =>
    out.outcome === 'noop'
      ? `it was already ${out.announcement.status}`
      : op === 'publish'
        ? 'announcement published'
        : 'announcement withdrawn',
  );
}
