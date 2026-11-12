import 'server-only';
import {
  academyLearnerSummariesSchema,
  academyOpsMetricsSchema,
  academyReportDeletedSchema,
  academyReportFileSchema,
  academyReportTaskInputSchema,
  academyReportTaskSchema,
  academyReportTasksSchema,
  academyRequestReportInputSchema,
  type AcademyReportFile,
} from '@intafaced/contracts/academy-analytics';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import { activityWindow, type AnalyticsView, type ReportsDeskReply, type ReportsView } from './analytics-model';

/**
 * The Academy's numbers and its reports centre, as the signed-in founder (AC-analytics-01, AC-analytics-02). svc-academy
 * counts from its own records, records the founder from their own token on every change, and refuses a blank owner value
 * by name. No money moves.
 */

/** This desk's own words for the codes it uses; the rest come from the shared catalogue. */
const COPY: Record<string, Omit<RefusalView, 'code' | 'changed'>> = {
  'academy.learner_summaries_list_limit_unset': {
    title: 'The summaries page size is not set',
    body: 'The owner has not set how many learners one page of summaries shows (ACADEMY_LEARNER_SUMMARIES_PAGE_SIZE), so svc-academy lists none.',
    next: 'The owner sets it for this deployment. Nothing was changed.',
  },
  'academy.report_tasks_list_limit_unset': {
    title: 'The report list size is not set',
    body: 'The owner has not set how many report tasks the list shows (ACADEMY_REPORT_TASKS_PAGE_SIZE), so svc-academy lists none.',
    next: 'The owner sets it for this deployment. Nothing was changed.',
  },
  'academy.report_retention_unset': {
    title: 'The report retention is not set',
    body: 'The owner has not set how long a finished report file is kept (ACADEMY_REPORT_RETENTION_HOURS), so no report is requested.',
    next: 'The owner sets it for this deployment. Nothing was requested.',
  },
  'academy.report_limit_unset': {
    title: 'The report size is not set',
    body: 'The owner has not set how many learner rows one report may hold (ACADEMY_REPORT_ROWS), so no report is requested.',
    next: 'The owner sets it for this deployment. Nothing was requested.',
  },
  'academy.report_sweep_unset': {
    title: 'Reports are not being run',
    body: 'The owner has not set how often requested reports are run (ACADEMY_REPORT_SWEEP_SECONDS), so a request would never finish and none is taken.',
    next: 'The owner sets it for this deployment. Nothing was requested.',
  },
  'academy.report_out_of_order': {
    title: 'That request number skips one',
    body: 'Your report requests are numbered one after another, and this number is past your next one.',
    next: 'The list is read again. Request from it. Nothing was requested.',
  },
  'academy.report_not_found': {
    title: 'No such report',
    body: 'svc-academy has no report task with this id, or it was deleted.',
    next: 'Pick a task from the list. Nothing was changed.',
  },
  'academy.report_not_ready': {
    title: 'This report has no file',
    body: 'Only a finished report has a file. A requested, running, aborted or failed one has none.',
    next: 'Read the list again. Nothing was served.',
  },
  'academy.report_not_abortable': {
    title: 'There is nothing to abort',
    body: 'Only a requested or running report can be aborted; this one has already finished or failed.',
    next: 'Delete it instead if it should go. Nothing was changed.',
  },
  'academy.report_expired': {
    title: 'This report file has expired',
    body: 'The file was kept for the owner’s retention period, which has ended, so it is no longer served.',
    next: 'Request the report again for a new file. Nothing was served.',
  },
};

export function analyticsRefusal(code: string | null, status: number, uncertain = false): RefusalView {
  const own = code ? COPY[code] : undefined;
  return own ? { ...own, code, changed: 'no' } : explainRefusal(code, status, uncertain);
}

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage: 'svc-academy did not accept your founder session. The Academy numbers need the Academy operator permission (admin:read).',
  refusedMessage: (code) => (code ? analyticsRefusal(code, 409).body : null),
};

const readMetrics = parseWith(academyOpsMetricsSchema);
const readSummaries = parseWith(academyLearnerSummariesSchema);
const readTasks = parseWith(academyReportTasksSchema);
const readTask = parseWith(academyReportTaskSchema);
const readDeleted = parseWith(academyReportDeletedSchema);
const readFile = parseWith(academyReportFileSchema);

export async function loadAnalytics(
  ctx: FounderCallContext,
  input: { tag: string | null; after: string | null; now: Date },
): Promise<AnalyticsView> {
  const [activity, summaries] = await Promise.all([
    founderCall(ctx, 'academy', 'admin.opsMetrics', 'GET', activityWindow(input.now), readMetrics),
    founderCall(
      ctx,
      'academy',
      'admin.learnerSummaries',
      'GET',
      { ...(input.tag ? { tag: input.tag } : {}), ...(input.after ? { after: input.after } : {}) },
      readSummaries,
    ),
  ]);
  return { activity: partFrom(activity, (d) => d, ACADEMY), summaries: partFrom(summaries, (d) => d, ACADEMY), tag: input.tag };
}

export async function loadReports(ctx: FounderCallContext): Promise<ReportsView> {
  const tasks = await founderCall(ctx, 'academy', 'admin.reportTasks', 'GET', undefined, readTasks);
  return { tasks: partFrom(tasks, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

/** Why a call gave no answer, as the desk shows it. */
function refusal(result: FounderCallResult<unknown>): { status: number; reply: ReportsDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...analyticsRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return refused(null, 502, true);
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

/** A finished task's stored file, exactly as svc-academy made it, or the typed refusal when it is not served. */
export async function loadReportFile(
  ctx: FounderCallContext,
  taskId: string,
): Promise<{ file: AcademyReportFile } | { status: number; reply: ReportsDeskReply }> {
  const result = await founderCall(ctx, 'academy', 'admin.reportFile', 'GET', { taskId }, readFile);
  return result.kind === 'ok' && result.data ? { file: result.data } : refusal(result);
}

export type ReportsOp = 'request' | 'abort' | 'delete';
export const isReportsOp = (op: unknown): op is ReportsOp => op === 'request' || op === 'abort' || op === 'delete';

export async function changeReports(
  ctx: FounderCallContext,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: ReportsDeskReply } | { why: string }> {
  const { op, ...input } = body;
  if (op === 'request') {
    const asked = academyRequestReportInputSchema.safeParse(input);
    if (!asked.success) return { why: 'Which report, which tag (or every learner), and which request number?' };
    const made = await founderCall(ctx, 'academy', 'admin.requestReport', 'POST', asked.data, readTask);
    if (made.kind !== 'ok' || !made.data) return refusal(made);
    // A retried request for a number already taken answers that task: its time says when it was requested.
    return { status: 200, reply: { ok: true, what: `report request ${made.data.n} taken at ${made.data.requestedAt}`, task: made.data } };
  }
  const named = academyReportTaskInputSchema.safeParse(input);
  if (!named.success) return { why: 'Which report task?' };
  if (op === 'abort') {
    const done = await founderCall(ctx, 'academy', 'admin.abortReport', 'POST', named.data, readTask);
    if (done.kind !== 'ok' || !done.data) return refusal(done);
    return { status: 200, reply: { ok: true, what: `report ${done.data.n} aborted; it will have no file`, task: done.data } };
  }
  const gone = await founderCall(ctx, 'academy', 'admin.deleteReport', 'POST', named.data, readDeleted);
  if (gone.kind !== 'ok' || !gone.data) return refusal(gone);
  return { status: 200, reply: { ok: true, what: 'report deleted with its file' } };
}
