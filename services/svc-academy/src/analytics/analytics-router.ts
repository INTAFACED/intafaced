/**
 * AC-analytics-01 and AC-analytics-02 (J-academy-16): the founder console's learner summaries and reports centre.
 * Operator only (`admin:read`; a change needs `admin:write`), module academy. The actor is the caller's own id from the
 * edge-signed principal, never the body. Refusals keep their code on the wire.
 */
import {
  academyLearnerSummariesInputSchema,
  academyLearnerSummariesSchema,
  academyReportDeletedSchema,
  academyReportFileSchema,
  academyReportTaskInputSchema,
  academyReportTaskSchema,
  academyReportTasksSchema,
  academyRequestReportInputSchema,
  scopedProcedure,
} from '@intafaced/contracts';
import { analyticsRefusals, type LearnerSummaries } from './learner-summaries.js';
import type { ReportTasks } from './report-tasks.js';

const { guard } = analyticsRefusals;
const read = () => scopedProcedure('admin:read', { module: 'academy' });
const write = () => scopedProcedure('admin:write', { module: 'academy' });

export function analyticsProcedures(summaries: LearnerSummaries, reports: ReportTasks) {
  return {
    learnerSummaries: read()
      .input(academyLearnerSummariesInputSchema)
      .output(academyLearnerSummariesSchema)
      .query(({ input }) => guard(() => summaries.page(input))),

    reportTasks: read()
      .output(academyReportTasksSchema)
      .query(({ ctx }) => guard(() => reports.list(ctx.principal!.userId))),

    requestReport: write()
      .input(academyRequestReportInputSchema)
      .output(academyReportTaskSchema)
      .mutation(({ input, ctx }) => guard(() => reports.request({ ...input, actorId: ctx.principal!.userId, now: new Date() }))),

    abortReport: write()
      .input(academyReportTaskInputSchema)
      .output(academyReportTaskSchema)
      .mutation(({ input, ctx }) => guard(() => reports.abort({ ...input, actorId: ctx.principal!.userId, now: new Date() }))),

    deleteReport: write()
      .input(academyReportTaskInputSchema)
      .output(academyReportDeletedSchema)
      .mutation(({ input, ctx }) => guard(() => reports.delete({ ...input, actorId: ctx.principal!.userId, now: new Date() }))),

    reportFile: read()
      .input(academyReportTaskInputSchema)
      .output(academyReportFileSchema)
      .query(({ input }) => guard(() => reports.file(input.taskId))),
  };
}
