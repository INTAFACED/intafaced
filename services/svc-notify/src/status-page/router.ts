import { z } from 'zod';
import {
  router,
  publicProcedure,
  scopedProcedure,
  TRPCError,
  statusPageConfigureInputSchema,
  statusPageSchema,
  statusReadingInputSchema,
  STATUS_UPTIME_DAYS_MAX,
} from '@intafaced/contracts';
import type { NoticeBoard } from '../notices/board.js';
import { StatusPageError, type StatusPageBook } from './book.js';
import { buildStatusPage, uptimeStart } from './page.js';

export type StatusPageDeps = { book: StatusPageBook; notices: NoticeBoard | null; now?: () => Date };

const definitionOutput = z.object({
  components: z.array(z.object({ id: z.string(), name: z.string(), group: z.string().nullable(), source: z.string().nullable() })),
  componentCap: z.number().int().nullable(),
  stalenessSeconds: z.number().int().nullable(),
  uptimeDays: z.number().int().nullable(),
  revision: z.number().int(),
  updatedAt: z.string().nullable(),
});

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
      if (err instanceof StatusPageError) {
        const code =
          err.code === 'status.page_revision_stale' || err.code === 'status.reading_conflict' ? 'CONFLICT' : 'PRECONDITION_FAILED';
        throw new TRPCError({ code, message: err.code, cause: err });
      }
      throw err;
    }
  }
  return router({
    read: publicProcedure.output(statusPageSchema).query(() =>
      call(async ({ book, notices }) => {
        const at = now();
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
      }),
    ),

    definition: scopedProcedure('admin:write', { module: 'notify' })
      .output(definitionOutput)
      .query(() => call(async ({ book }) => definitionOutput.parse(await book.definition()))),

    configure: scopedProcedure('admin:write', { module: 'notify' })
      .input(statusPageConfigureInputSchema)
      .output(definitionOutput)
      .mutation(({ ctx, input }) =>
        call(async ({ book }) =>
          definitionOutput.parse(await book.configure({ input, by: ctx.principal.userId, at: now().toISOString() })),
        ),
      ),

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
