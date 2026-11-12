import type {
  AcademyLearnerSummaries,
  AcademyOpsMetrics,
  AcademyReportTask,
  AcademyReportTasks,
} from '@intafaced/contracts/academy-analytics';
import type { Part } from '@/lib/desk/part';

/**
 * The Academy's numbers and reports centre on the founder console (AC-analytics-01, AC-analytics-02; J-academy-16).
 * Pure, so the server loaders, the route and the browser component share it.
 */
export type { AcademyLearnerSummaries, AcademyOpsMetrics, AcademyReportTask, AcademyReportTasks };

/** Days the activity table covers, today (UTC) last. */
export const ACTIVITY_DAYS = 14;

export interface AnalyticsView {
  readonly activity: Part<AcademyOpsMetrics>;
  readonly summaries: Part<AcademyLearnerSummaries>;
  readonly tag: string | null;
}

export interface ReportsView {
  readonly tasks: Part<AcademyReportTasks>;
  readonly asOf: string;
}

export type ReportsDeskReply =
  | { readonly ok: true; readonly what: string; readonly task?: AcademyReportTask }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

const DAY_MS = 86_400_000;
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The activity window: the last ACTIVITY_DAYS whole UTC days, ending today. */
export function activityWindow(now: Date): { from: string; to: string } {
  return { from: utcDay(now.getTime() - (ACTIVITY_DAYS - 1) * DAY_MS), to: utcDay(now.getTime()) };
}

/** A count as the table shows it: the number, or "not recorded" for a day the service did not record. Never zero for a gap. */
export function cellText(cell: { value: number | null; reason: string | null }): string {
  return cell.value === null ? 'not recorded' : String(cell.value);
}

const STATE_WORDS: Record<AcademyReportTask['state'], string> = {
  queued: 'Requested',
  running: 'Running',
  done: 'Finished',
  aborted: 'Aborted',
  failed: 'Failed',
};

/** A task's state in words; a finished file past its retention says Expired. */
export function stateText(task: AcademyReportTask): string {
  return task.expired ? 'Expired' : STATE_WORDS[task.state];
}
