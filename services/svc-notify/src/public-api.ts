/**
 * The documented read API for status and notices (SP-api-01, journey J-support-public-09 #1 and #2).
 *
 * Plain GET routes under `/v1`, public through Edge at `/api/notify/v1/...`, signed out. Each one answers what the site
 * reads through tRPC, with no field added or dropped: notices are the `notify.notices` wire form, one notice is
 * `notify.notice`, the status is `statusPage.read`. Nothing here writes.
 *
 * Paging: `limit` is required (there is no default page size, the same as the tRPC read) and is capped at
 * NOTICES_LIST_LIMIT_MAX. A full page carries `next`, the id to pass as `after` for the page that follows; a short page
 * carries `next: null`.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { StatusPage } from '@intafaced/contracts/status-page';
import { NOTICES_LIST_LIMIT_MAX, NoticeError, type NoticeBoard } from './notices/board.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = /^[1-9][0-9]{0,3}$/;

export type PublicReadApiDeps = {
  readonly notices: Pick<NoticeBoard, 'notices' | 'notice'> | null;
  readonly statusPage: () => Promise<StatusPage>;
};

function refuse(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ code });
}

/** Typed refusals keep their code; anything else is the service being unable to answer, not a guess. */
function noticeFailure(reply: FastifyReply, err: unknown) {
  if (err instanceof NoticeError) {
    return refuse(reply, err.code === 'notify.notice_not_found' ? 404 : 400, err.code);
  }
  return refuse(reply, 503, 'notify.notices_unavailable');
}

export function registerPublicReadApi(app: FastifyInstance, deps: PublicReadApiDeps): void {
  app.get<{ Querystring: Record<string, unknown> }>('/v1/notices', async (request, reply) => {
    const { kind, limit, after } = request.query;
    if (typeof limit !== 'string' || !LIMIT.test(limit)) return refuse(reply, 400, 'notify.notices_limit_invalid');
    if (kind !== undefined && typeof kind !== 'string') return refuse(reply, 400, 'notify.notice_kind_unknown');
    if (after !== undefined && (typeof after !== 'string' || !UUID.test(after))) {
      return refuse(reply, 400, 'notify.notices_cursor_unknown');
    }
    if (!deps.notices) return refuse(reply, 503, 'notify.notices_unavailable');
    const size = Math.min(Number(limit), NOTICES_LIST_LIMIT_MAX);
    try {
      const notices = await deps.notices.notices({ kind: kind ?? null, limit: size, after: after ?? null });
      const last = notices.at(-1);
      return { notices, next: notices.length === size && last ? last.id : null };
    } catch (err) {
      return noticeFailure(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/v1/notices/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return refuse(reply, 404, 'notify.notice_not_found');
    if (!deps.notices) return refuse(reply, 503, 'notify.notices_unavailable');
    try {
      return await deps.notices.notice(request.params.id);
    } catch (err) {
      return noticeFailure(reply, err);
    }
  });

  app.get('/v1/status', async (_request, reply) => {
    try {
      return await deps.statusPage();
    } catch {
      return refuse(reply, 503, 'notify.status_page_unavailable');
    }
  });
}
