import 'server-only';
import type { AcademyReportCentreFile } from '@intafaced/contracts/academy-analytics';
import {
  ACADEMY_ADMIN_ABORT_REPORT,
  ACADEMY_ADMIN_DELETE_REPORT,
  ACADEMY_ADMIN_LEARNER_SUMMARIES,
  ACADEMY_ADMIN_OPS_METRICS,
  ACADEMY_ADMIN_REPORT_CENTRE_FILE,
  ACADEMY_ADMIN_REPORT_CENTRE_TASKS,
  ACADEMY_ADMIN_REQUEST_REPORT,
} from '@intafaced/contracts/academy-admin-procedures';
import {
  founderRecordCall,
  type FounderCallContext,
  type FounderCallResult,
  partFrom,
  type PartLabels,
  explainRefusal,
  type RefusalView,
} from '@/lib/desk';
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
    body: 'The owner has not set how long a finished report file is kept (ACADEMY_REPORT_CENTRE_RETENTION_MINUTES), so no report is requested.',
    next: 'The owner sets it for this deployment. Nothing was requested.',
  },
  'academy.report_limit_unset': {
    title: 'The report size is not set',
    body: 'The owner has not set how many learner rows one report may hold (ACADEMY_LEARNER_EXPORT_ROWS), so no report is requested.',
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
  forbiddenMessage:
    'svc-academy did not accept your founder session. The Academy numbers need the Academy operator permission (admin:read).',
  refusedMessage: (code) => (code ? analyticsRefusal(code, 409).body : null),
};

export async function loadAnalytics(
  ctx: FounderCallContext,
  input: { tag: string | null; after: string | null; now: Date },
): Promise<AnalyticsView> {
  const [activity, summaries] = await Promise.all([
    founderRecordCall(ctx, ACADEMY_ADMIN_OPS_METRICS, activityWindow(input.now)),
    founderRecordCall(ctx, ACADEMY_ADMIN_LEARNER_SUMMARIES, {
      ...(input.tag ? { tag: input.tag } : {}),
      ...(input.after ? { after: input.after } : {}),
    }),
  ]);
  return { activity: partFrom(activity, (d) => d, ACADEMY), summaries: partFrom(summaries, (d) => d, ACADEMY), tag: input.tag };
}

export async function loadReports(ctx: FounderCallContext): Promise<ReportsView> {
  const tasks = await founderRecordCall(ctx, ACADEMY_ADMIN_REPORT_CENTRE_TASKS, undefined);
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
): Promise<{ file: AcademyReportCentreFile } | { status: number; reply: ReportsDeskReply }> {
  const result = await founderRecordCall(ctx, ACADEMY_ADMIN_REPORT_CENTRE_FILE, { taskId });
  return result.kind === 'ok' ? { file: result.data } : refusal(result);
}

export type ReportsOp = 'request' | 'abort' | 'delete';
export const isReportsOp = (op: unknown): op is ReportsOp => op === 'request' || op === 'abort' || op === 'delete';

export async function changeReports(
  ctx: FounderCallContext,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: ReportsDeskReply } | { why: string }> {
  const { op, ...input } = body;
  if (op === 'request') {
    const asked = ACADEMY_ADMIN_REQUEST_REPORT.input.safeParse(input);
    if (!asked.success) return { why: 'Which report, which tag (or every learner), and which request number?' };
    const made = await founderRecordCall(ctx, ACADEMY_ADMIN_REQUEST_REPORT, asked.data);
    if (made.kind !== 'ok') return refusal(made);
    // A retried request for a number already taken answers that task: its time says when it was requested.
    return { status: 200, reply: { ok: true, what: `report request ${made.data.n} taken at ${made.data.requestedAt}`, task: made.data } };
  }
  const named = ACADEMY_ADMIN_ABORT_REPORT.input.safeParse(input);
  if (!named.success) return { why: 'Which report task?' };
  if (op === 'abort') {
    const done = await founderRecordCall(ctx, ACADEMY_ADMIN_ABORT_REPORT, named.data);
    if (done.kind !== 'ok') return refusal(done);
    return { status: 200, reply: { ok: true, what: `report ${done.data.n} aborted; it will have no file`, task: done.data } };
  }
  const gone = await founderRecordCall(ctx, ACADEMY_ADMIN_DELETE_REPORT, named.data);
  if (gone.kind !== 'ok') return refusal(gone);
  return { status: 200, reply: { ok: true, what: 'report deleted with its file' } };
}
