/**
 * Public REST door for announcements: GET /api/v1/announcements?kind=&locale=&limit=
 * (SP-developer-status-02, lead ruling D27). Signed-out read, like the tRPC
 * `notices` read. Published notices only. Every failure is a typed code, never
 * an empty list that reads as "no announcements".
 */

import type { FastifyInstance } from 'fastify';
import { NoticeError, type NoticeBoard, type NoticeCode, type NoticeWire } from './board.js';

export const ANNOUNCEMENTS_PATH = '/api/v1/announcements';

const BAD_REQUEST: ReadonlySet<NoticeCode> = new Set<NoticeCode>([
  'notify.notice_kind_unknown',
  'notify.notice_locale_unknown',
  'notify.notices_limit_invalid',
]);

export type AnnouncementsReply = { readonly announcements: readonly NoticeWire[] };

function single(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return null; // repeated or structured parameter
}

/** Registers the door. `board` is null when svc-notify runs without the notices board. */
export function registerAnnouncementsRoute(app: FastifyInstance, board: Pick<NoticeBoard, 'announcements'> | null | undefined): void {
  app.get(ANNOUNCEMENTS_PATH, async (request, reply) => {
    if (!board) return reply.code(503).send({ code: 'notify.notices_unavailable' });
    const query = (request.query ?? {}) as Record<string, unknown>;
    const kind = single(query.kind);
    const locale = single(query.locale);
    const rawLimit = single(query.limit);
    if (kind === null) return reply.code(400).send({ code: 'notify.notice_kind_unknown' });
    if (locale === null) return reply.code(400).send({ code: 'notify.notice_locale_unknown' });
    if (rawLimit === null || (rawLimit !== undefined && !/^[0-9]{1,6}$/.test(rawLimit))) {
      return reply.code(400).send({ code: 'notify.notices_limit_invalid' });
    }
    try {
      const announcements = await board.announcements({
        kind: kind ?? null,
        locale: locale ?? null,
        limit: rawLimit === undefined ? null : Number(rawLimit),
      });
      const body: AnnouncementsReply = { announcements };
      return reply.code(200).send(body);
    } catch (err) {
      if (err instanceof NoticeError) {
        return reply.code(BAD_REQUEST.has(err.code) ? 400 : 503).send({ code: err.code });
      }
      request.log.error({ err }, 'svc-notify announcements read failed');
      return reply.code(503).send({ code: 'notify.notices_unavailable' });
    }
  });
}
