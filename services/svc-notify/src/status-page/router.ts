import { z } from 'zod';
import type { StatusPage } from '@intafaced/contracts';
import { statusPageSchema, statusBadgeInputSchema, statusBadgeSchema, STATUS_UPTIME_DAYS_MAX } from '@intafaced/contracts/status-page';
import { router, publicProcedure, TRPCError } from '@intafaced/contracts/trpc';
import type { NoticeBoard } from '../notices/board.js';
import { StatusPageError, type StatusPageBook } from './book.js';
import { statusBadge } from './badge.js';
import { buildStatusPage, uptimeStart } from './page.js';
import type { StatusSubscriptions } from './subscriptions.js';
import { TemplateError, type IncidentTemplate, type IncidentTemplates } from './templates.js';
import { statusSubscriptionsRouter } from './subscriptions-router.js';
import { MaintenanceError, type MaintenanceLifecycle, type MaintenanceWindow } from '../notices/maintenance.js';
import { toOperatorNotice } from '../notices/board.js';
import { POSTMORTEMS_LIST_MAX, PostmortemError, type Postmortem, type Postmortems } from './postmortems.js';
import {
  postmortemOutput,
  definitionOutput,
  maintenanceWindowOutput,
  NOTIFY_STATUS_PAGE_POSTMORTEMS_FOR_INCIDENTS,
  NOTIFY_STATUS_PAGE_TEMPLATES_LIST,
  NOTIFY_STATUS_PAGE_DEFINITION,
  NOTIFY_STATUS_PAGE_POSTMORTEMS_PROPOSAL,
  NOTIFY_STATUS_PAGE_POSTMORTEMS_WRITE,
  NOTIFY_STATUS_PAGE_POSTMORTEMS_PUBLISH,
  NOTIFY_STATUS_PAGE_TEMPLATES_DEFINE,
  NOTIFY_STATUS_PAGE_TEMPLATES_RETIRE,
  NOTIFY_STATUS_PAGE_MAINTENANCE_WINDOWS,
  NOTIFY_STATUS_PAGE_MAINTENANCE_MOVE,
  NOTIFY_STATUS_PAGE_READ,
  NOTIFY_STATUS_PAGE_RECORD,
  NOTIFY_STATUS_PAGE_CONFIGURE,
} from '@intafaced/contracts/notify-status-page-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { notifyRefusal } from '../record-refusal.js';

export type StatusPageDeps = {
  book: StatusPageBook;
  notices: NoticeBoard | null;
  subscriptions?: StatusSubscriptions;
  /** Incident templates (SP-status-02). Absent, the template calls answer `notify.status_page_unavailable`. */
  templates?: IncidentTemplates;
  /** Incident postmortems (SP-status-02). Absent, the postmortem calls answer `notify.status_page_unavailable`. */
  postmortems?: Postmortems;
  /** Scheduled maintenance lifecycle (SP-status-03). Absent, its calls answer `notify.status_page_unavailable`. */
  maintenance?: MaintenanceLifecycle;
  /** NOTIFY_PUBLIC_ORIGIN: the site address badge and subscription links use. Unset, the founders' read says so. */
  publicOrigin?: string | null;
  now?: () => Date;
};

/** What a visitor reads: who wrote it stays with the founders. */
const publishedPostmortemOutput = z.object({
  incidentId: z.string(),
  body: z.string(),
  version: z.number().int(),
  publishedAt: z.string(),
});

const maintenanceWire = (w: MaintenanceWindow) =>
  maintenanceWindowOutput.parse({
    notice: toOperatorNotice(w.notice),
    state: w.state,
    moves: w.moves.map((m) => ({ state: m.state, movedBy: m.movedBy, reason: m.reason, movedAt: m.movedAt.toISOString() })),
    reminders: w.reminders.map((r) => ({
      offsetMinutes: r.offsetMinutes,
      dueAt: r.dueAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      skipped: r.skipped,
    })),
  });

const postmortemWire = (p: Postmortem) => postmortemOutput.parse(p);

function requirePostmortems(postmortems: Postmortems | undefined): Postmortems {
  if (!postmortems) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.status_page_unavailable' });
  return postmortems;
}

const originOrNull = (origin: string | null | undefined): string | null => {
  const trimmed = origin?.trim().replace(/\/+$/, '') ?? '';
  return trimmed === '' ? null : trimmed;
};

const templateWire = (t: IncidentTemplate) => ({ ...t, components: [...t.components] });

function requireTemplates(templates: IncidentTemplates | undefined): IncidentTemplates {
  if (!templates) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.status_page_unavailable' });
  return templates;
}

/** The page as a visitor reads it now: definition, latest readings, the uptime window and the incident feed. */
export async function readStatusPage({ book, notices }: StatusPageDeps, at: Date): Promise<StatusPage> {
  const definition = await book.definition();
  // Incidents resolved inside the uptime window are listed; with the window blank, the feed's own maximum.
  const days = definition.uptimeDays ?? STATUS_UPTIME_DAYS_MAX;
  const ids = definition.components.map((c) => c.id);
  const [latest, window, feed] = await Promise.all([
    book.latest(),
    definition.uptimeDays === null ? Promise.resolve([]) : book.daily(uptimeStart(at, days)),
    notices
      ? notices.statusFeedFor(ids, { days: Math.min(days, STATUS_UPTIME_DAYS_MAX) }, at)
      : Promise.resolve({ incidents: [], maintenance: [] }),
  ]);
  return statusPageSchema.parse(buildStatusPage({ definition, latest, window, feed, at }));
}

/**
 * The public status page (SP-status-01). `read` is signed-out. `configure` and `record` are founder calls under the same
 * scope as the notice board (`admin:write`, module notify); `configure` names the revision it read and a reason.
 */
export function statusPageRouter(deps?: StatusPageDeps) {
  const now = () => deps?.now?.() ?? new Date();
  async function call<T>(run: (deps: StatusPageDeps) => Promise<T>): Promise<T> {
    if (!deps) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.status_page_unavailable' });
    try {
      return await run(deps);
    } catch (err) {
      if (err instanceof TemplateError)
        throw new TRPCError({
          code: err.code === 'status.template_not_found' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
          message: err.code,
          cause: err,
        });
      if (err instanceof MaintenanceError) {
        const code =
          err.code === 'status.maintenance_unknown'
            ? 'NOT_FOUND'
            : err.code === 'status.maintenance_reason_unset'
              ? 'BAD_REQUEST'
              : 'CONFLICT';
        throw new TRPCError({ code, message: err.code, cause: err });
      }
      if (err instanceof PostmortemError) {
        const code =
          err.code === 'status.postmortem_not_found' || err.code === 'status.postmortem_incident_unknown'
            ? 'NOT_FOUND'
            : err.code === 'status.postmortem_version_stale'
              ? 'CONFLICT'
              : err.code === 'status.postmortem_invalid'
                ? 'BAD_REQUEST'
                : 'PRECONDITION_FAILED';
        throw new TRPCError({ code, message: err.code, cause: err });
      }
      if (err instanceof StatusPageError) {
        const code =
          err.code === 'status.page_revision_stale' || err.code === 'status.reading_conflict' ? 'CONFLICT' : 'PRECONDITION_FAILED';
        throw new TRPCError({ code, message: err.code, cause: err });
      }
      throw err;
    }
  }
  return router({
    subscriptions: statusSubscriptionsRouter(deps?.subscriptions, deps?.notices),

    read: mountRecord(NOTIFY_STATUS_PAGE_READ, () => call((deps) => readStatusPage(deps, now())), notifyRefusal),

    badge: publicProcedure
      .input(statusBadgeInputSchema)
      .output(statusBadgeSchema)
      .query(({ input }) =>
        call(async (deps) => {
          const badge = statusBadge(await readStatusPage(deps, now()), input.componentId);
          if (!badge) throw new TRPCError({ code: 'NOT_FOUND', message: 'status.component_unknown' });
          return badge;
        }),
      ),

    definition: mountRecord(
      NOTIFY_STATUS_PAGE_DEFINITION,
      () =>
        call(async ({ book, publicOrigin }) =>
          definitionOutput.parse({ ...(await book.definition()), publicOrigin: originOrNull(publicOrigin) }),
        ),
      notifyRefusal,
    ),

    configure: mountRecord(
      NOTIFY_STATUS_PAGE_CONFIGURE,
      ({ ctx, input }) =>
        call(async ({ book, publicOrigin }) =>
          definitionOutput.parse({
            ...(await book.configure({ input, by: ctx.principal.userId, at: now().toISOString() })),
            publicOrigin: originOrNull(publicOrigin),
          }),
        ),
      notifyRefusal,
    ),

    /**
     * Incident templates (SP-status-02): founders only, like the definition. Nothing is seeded, so an empty list is the
     * honest answer until a founder defines one.
     */
    templates: router({
      list: mountRecord(
        NOTIFY_STATUS_PAGE_TEMPLATES_LIST,
        () => call(async ({ templates }) => (await requireTemplates(templates).list()).map(templateWire)),
        notifyRefusal,
      ),
      define: mountRecord(
        NOTIFY_STATUS_PAGE_TEMPLATES_DEFINE,
        ({ ctx, input }) =>
          call(async ({ templates }) => templateWire(await requireTemplates(templates).define(ctx.principal.userId, input))),
        notifyRefusal,
      ),
      retire: mountRecord(
        NOTIFY_STATUS_PAGE_TEMPLATES_RETIRE,
        ({ ctx, input }) =>
          call(async ({ templates }) => {
            await requireTemplates(templates).retire(ctx.principal.userId, input.id);
            return { id: input.id, retired: true as const };
          }),
        notifyRefusal,
      ),
    }),

    /**
     * Postmortems (SP-status-02): written by founders on a resolved incident, published with a second founder's approval,
     * read by anyone once published.
     */
    postmortems: router({
      published: publicProcedure
        .input(
          z
            .object({ limit: z.number().int().min(1).max(POSTMORTEMS_LIST_MAX).default(50) })
            .strict()
            .optional(),
        )
        .output(z.array(publishedPostmortemOutput))
        .query(({ input }) =>
          call(async ({ postmortems }) =>
            (await requirePostmortems(postmortems).published(input?.limit ?? 50)).map((p) => ({
              incidentId: p.incidentId,
              body: p.body,
              version: p.version,
              publishedAt: p.publishedAt!,
            })),
          ),
        ),
      forIncidents: mountRecord(
        NOTIFY_STATUS_PAGE_POSTMORTEMS_FOR_INCIDENTS,
        ({ input }) =>
          call(async ({ postmortems }) => (await requirePostmortems(postmortems).forIncidents(input.incidentIds)).map(postmortemWire)),
        notifyRefusal,
      ),
      write: mountRecord(
        NOTIFY_STATUS_PAGE_POSTMORTEMS_WRITE,
        ({ ctx, input }) =>
          call(async ({ postmortems }) => postmortemWire(await requirePostmortems(postmortems).write(ctx.principal.userId, input))),
        notifyRefusal,
      ),
      proposal: mountRecord(
        NOTIFY_STATUS_PAGE_POSTMORTEMS_PROPOSAL,
        ({ input }) => call(async ({ postmortems }) => requirePostmortems(postmortems).proposal(input.incidentId)),
        notifyRefusal,
      ),
      publish: mountRecord(
        NOTIFY_STATUS_PAGE_POSTMORTEMS_PUBLISH,
        ({ ctx, input }) =>
          call(async ({ postmortems }) => postmortemWire(await requirePostmortems(postmortems).publish(ctx.principal.userId, input))),
        notifyRefusal,
      ),
    }),

    /**
     * Scheduled maintenance (SP-status-03): the founders' desk of windows with their derived state, moves and reminders,
     * and the operator's moves. Drafting and the four-eyes publish are the notice board's (`notify.draftNotice` and on).
     */
    maintenance: router({
      windows: mountRecord(
        NOTIFY_STATUS_PAGE_MAINTENANCE_WINDOWS,
        ({ input }) =>
          call(async ({ notices, maintenance }) => {
            if (!notices || !maintenance) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.status_page_unavailable' });
            return (await maintenance.windows(await notices.maintenanceRows(input?.limit ?? 50))).map(maintenanceWire);
          }),
        notifyRefusal,
      ),
      move: mountRecord(
        NOTIFY_STATUS_PAGE_MAINTENANCE_MOVE,
        ({ ctx, input }) =>
          call(async ({ maintenance }) => {
            if (!maintenance) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.status_page_unavailable' });
            return maintenanceWire(await maintenance.move(ctx.principal.userId, input));
          }),
        notifyRefusal,
      ),
    }),

    record: mountRecord(
      NOTIFY_STATUS_PAGE_RECORD,
      ({ ctx, input }) =>
        call(async ({ book }) => {
          const stored = await book.record({ ...input, observedAt: new Date(input.observedAt) }, ctx.principal.userId, now());
          return { ...stored, observedAt: stored.observedAt.toISOString() };
        }),
      notifyRefusal,
    ),
  });
}
