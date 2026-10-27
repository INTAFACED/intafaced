import 'server-only';
import { academyCourseGradebookSchema, academySaveGradingPolicyInputSchema } from '@intafaced/contracts/academy-course-gradebook';
import {
  academyGradeReportFileSchema,
  academyGradeReportSchema,
  academyGradeReportsSchema,
  academyMakeGradeReportInputSchema,
  type AcademyGradeReportFile,
} from '@intafaced/contracts/academy-grade-reports';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { GradebookDeskReply, GradebookView } from './gradebook-model';

/**
 * A course's grading policy and gradebook as the signed-in founder (AC-assignments-04). svc-academy records the founder
 * from their own token with the reason on every save, refuses weights that do not add up to exactly 1, and works every
 * figure out from stored grades. No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. The gradebook needs the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readGradebook = parseWith(academyCourseGradebookSchema);
const readReports = parseWith(academyGradeReportsSchema);
const readReport = parseWith(academyGradeReportSchema);
const readReportFile = parseWith(academyGradeReportFileSchema);

export async function loadGradebook(ctx: FounderCallContext, courseId: string): Promise<GradebookView> {
  const [book, stored] = await Promise.all([
    founderCall(ctx, 'academy', 'admin.courseGradebook', 'GET', { courseId }, readGradebook),
    founderCall(ctx, 'academy', 'admin.courseGradeReports', 'GET', { courseId }, readReports),
  ]);
  return { gradebook: partFrom(book, (d) => d, ACADEMY), reports: partFrom(stored, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

/** One stored report with its CSV, exactly as svc-academy made it, or the typed refusal when it cannot be read. */
export async function loadGradeReportFile(
  ctx: FounderCallContext,
  courseId: string,
  n: number,
): Promise<{ file: AcademyGradeReportFile } | { status: number; reply: GradebookDeskReply }> {
  const result = await founderCall(ctx, 'academy', 'admin.gradeReportFile', 'GET', { courseId, n }, readReportFile);
  return result.kind === 'ok' && result.data ? { file: result.data } : refusal(result);
}

/** Why a call gave no answer, as the desk shows it. */
function refusal(result: FounderCallResult<unknown>): { status: number; reply: GradebookDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
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

const WHY =
  'Each type needs a name, a weight from 0.0001 to 1 with up to four places, a whole number of lowest scores to drop and at least one item. Say why in up to 500 characters.';

export const isGradebookOp = (op: unknown): op is 'savePolicy' | 'makeReport' => op === 'savePolicy' || op === 'makeReport';

export async function changeGradebook(
  ctx: FounderCallContext,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: GradebookDeskReply } | { why: string }> {
  const { op, ...input } = body;
  if (op === 'makeReport') {
    const asked = academyMakeGradeReportInputSchema.safeParse(input);
    if (!asked.success) return { why: 'Which course, and which report number?' };
    const made = await founderCall(ctx, 'academy', 'admin.makeGradeReport', 'POST', asked.data, readReport);
    if (made.kind !== 'ok' || !made.data) return refusal(made);
    // A retried or stale request for a number already made answers that stored report: the time says when it was made.
    return { status: 200, reply: { ok: true, what: `grade report ${made.data.n} made at ${made.data.madeAt}`, report: made.data } };
  }
  const parsed = academySaveGradingPolicyInputSchema.safeParse(input);
  if (!parsed.success) return { why: WHY };
  const saved = await founderCall(ctx, 'academy', 'admin.saveGradingPolicy', 'POST', parsed.data, readGradebook);
  if (saved.kind !== 'ok' || !saved.data) return refusal(saved);
  return { status: 200, reply: { ok: true, what: 'grading policy saved', gradebook: saved.data } };
}
