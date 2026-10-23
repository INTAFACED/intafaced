import { z } from 'zod';
import {
  router,
  publicProcedure,
  scopedProcedure,
  TRPCError,
  statusPageConfigureInputSchema,
  statusPageSchema,
  statusBadgeInputSchema,
  statusBadgeSchema,
  type StatusPage,
  statusReadingInputSchema,
  STATUS_UPTIME_DAYS_MAX,
} from '@intafaced/contracts';
import type { NoticeBoard } from '../notices/board.js';
import { StatusPageError, type StatusPageBook } from './book.js';
import { statusBadge } from './badge.js';
import { buildStatusPage, uptimeStart } from './page.js';
import type { StatusSubscriptions } from './subscriptions.js';
import { TEMPLATE_ID_PATTERN, TemplateError, type IncidentTemplate, type IncidentTemplates } from './templates.js';
import { statusSubscriptionsRouter } from './subscriptions-router.js';

export type StatusPageDeps = {
  book: StatusPageBook;
  notices: NoticeBoard | null;
  subscriptions?: StatusSubscriptions;
  /** Incident templates (SP-status-02). Absent, the template calls answer `notify.status_page_unavailable`. */
  templates?: IncidentTemplates;
  /** NOTIFY_PUBLIC_ORIGIN: the site address badge and subscription links use. Unset, the founders' read says so. */
  publicOrigin?: string | null;
  now?: () => Date;
};

const definitionOutput = z.object({
  components: z.array(z.object({ id: z.string(), name: z.string(), group: z.string().nullable(), source: z.string().nullable() })),
  componentCap: z.number().int().nullable(),
  stalenessSeconds: z.number().int().nullable(),
  uptimeDays: z.number().int().nullable(),
  challengeBits: z.number().int().nullable(),
  subscribeRatePerHour: z.number().int().nullable(),
  revision: z.number().int(),
  updatedAt: z.string().nullable(),
  /** The public site address (no trailing slash) the founder console builds badge snippets on; null when not set. */
  publicOrigin: z.string().nullable(),
});

const templateOutput = z.object({
  id: z.string(),
  name: z.string(),
  group: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  impact: z.enum(['none', 'minor', 'major', 'critical']).nullable(),
  components: z.array(z.string()),
  definedBy: z.string(),
  definedAt: z.string(),
});

const templateInput = z
  .object({
    id: z.string().regex(TEMPLATE_ID_PATTERN),
    name: z.string().min(1).max(80),
    group: z.string().max(80).nullable().optional(),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(8000),
    impact: z.enum(['none', 'minor', 'major', 'critical']).nullable().optional(),
    components: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{1,39}$/))
      .max(100)
      .nullable()
      .optional(),
  })
  .strict();

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

    read: publicProcedure.output(statusPageSchema).query(() => call((deps) => readStatusPage(deps, now()))),

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

    definition: scopedProcedure('admin:write', { module: 'notify' })
      .output(definitionOutput)
      .query(() =>
        call(async ({ book, publicOrigin }) =>
          definitionOutput.parse({ ...(await book.definition()), publicOrigin: originOrNull(publicOrigin) }),
        ),
      ),

    configure: scopedProcedure('admin:write', { module: 'notify' })
      .input(statusPageConfigureInputSchema)
      .output(definitionOutput)
      .mutation(({ ctx, input }) =>
        call(async ({ book, publicOrigin }) =>
          definitionOutput.parse({
            ...(await book.configure({ input, by: ctx.principal.userId, at: now().toISOString() })),
            publicOrigin: originOrNull(publicOrigin),
          }),
        ),
      ),

    /**
     * Incident templates (SP-status-02): founders only, like the definition. Nothing is seeded, so an empty list is the
     * honest answer until a founder defines one.
     */
    templates: router({
      list: scopedProcedure('admin:write', { module: 'notify' })
        .output(z.array(templateOutput))
        .query(() => call(async ({ templates }) => (await requireTemplates(templates).list()).map(templateWire))),
      define: scopedProcedure('admin:write', { module: 'notify' })
        .input(templateInput)
        .output(templateOutput)
        .mutation(({ ctx, input }) =>
          call(async ({ templates }) => templateWire(await requireTemplates(templates).define(ctx.principal.userId, input))),
        ),
      retire: scopedProcedure('admin:write', { module: 'notify' })
        .input(z.object({ id: z.string().regex(TEMPLATE_ID_PATTERN) }).strict())
        .output(z.object({ id: z.string(), retired: z.literal(true) }))
        .mutation(({ ctx, input }) =>
          call(async ({ templates }) => {
            await requireTemplates(templates).retire(ctx.principal.userId, input.id);
            return { id: input.id, retired: true as const };
          }),
        ),
    }),

    record: scopedProcedure('admin:write', { module: 'notify' })
      .input(statusReadingInputSchema)
      .output(z.object({ componentId: z.string(), state: z.string(), observedAt: z.string(), source: z.string() }))
      .mutation(({ ctx, input }) =>
        call(async ({ book }) => {
          const stored = await book.record({ ...input, observedAt: new Date(input.observedAt) }, ctx.principal.userId, now());
          return { ...stored, observedAt: stored.observedAt.toISOString() };
        }),
      ),
  });
}
