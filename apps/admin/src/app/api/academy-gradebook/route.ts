import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeGradebook, isGradebookOp, loadGradebook, loadGradeReportFile } from '@/lib/academy/gradebook-server';

/**
 * The gradebook of a course staff made (AC-assignments-04).
 *
 *   GET ?courseId=<uuid>   the grading policy, the course's graded items, each enrolled learner's scores and the stored reports
 *   GET ?courseId=<uuid>&report=<n>   stored grade report n as a CSV download, with its SHA-256
 *   POST { op: 'makeReport', courseId, n }   stores report n: the gradebook now, with its time and hash
 *   POST { op: 'savePolicy', courseId, revision, types, reason }   weights adding up to exactly 1, with dropped lowest
 *   POST { op: 'saveLatePolicy', courseId, revision, policy: { graceHours, deductionPerDay } | null, reason }   the late policy
 *
 * Founder-only. svc-academy records the founder from their own token.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const incomplete = (body: string) =>
  Response.json(
    {
      ok: false,
      title: 'That request is not complete',
      body,
      next: 'Nothing was changed. Correct it and try again.',
      code: null,
      changed: 'no',
    },
    { status: 400, headers: NO_STORE },
  );

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const courseId = new URL(request.url).searchParams.get('courseId') ?? '';
  if (!UUID.test(courseId)) return incomplete('Which course?');
  const report = new URL(request.url).searchParams.get('report');
  if (report !== null) {
    if (!/^[1-9]\d{0,8}$/.test(report)) return incomplete('Which report?');
    let read: Awaited<ReturnType<typeof loadGradeReportFile>>;
    try {
      read = await loadGradeReportFile(session, courseId, Number(report));
    } catch (error) {
      return adminSessionErrorResponse(error);
    }
    if (!('file' in read)) return Response.json(read.reply, { status: read.status, headers: NO_STORE });
    const { file } = read;
    // The stored snapshot, byte for byte: the hash the desk shows is the hash of this body.
    return new Response(file.csv, {
      headers: {
        ...NO_STORE,
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="grade-report-${courseId}-${file.n}.csv"`,
        'x-report-sha256': file.sha256,
      },
    });
  }
  return Response.json(await loadGradebook(session, courseId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isGradebookOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeGradebook(session, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
