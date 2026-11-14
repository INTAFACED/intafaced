import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeReports, isReportsOp, loadReportFile, loadReports } from '@/lib/academy/analytics-server';

/**
 * The Academy reports centre (AC-analytics-02).
 *
 *   GET                  every report task not deleted, newest first, and the founder's next request number
 *   GET ?task=<uuid>     a finished task's stored file as a CSV download, with its SHA-256
 *   POST { op: 'request', kind: 'learners', tag: <tag> | null, n }   requests report n; the report sweep runs it
 *   POST { op: 'abort', taskId }    stops a requested or running report; it never gets a file
 *   POST { op: 'delete', taskId }   takes a task off the list and drops its file
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
  const task = new URL(request.url).searchParams.get('task');
  try {
    if (task === null) return Response.json(await loadReports(session), { headers: NO_STORE });
    if (!UUID.test(task)) return incomplete('Which report?');
    const read = await loadReportFile(session, task);
    if (!('file' in read)) return Response.json(read.reply, { status: read.status, headers: NO_STORE });
    const { file } = read;
    // The stored file, byte for byte: the hash the desk shows is the hash of this body.
    return new Response(file.csv, {
      headers: {
        ...NO_STORE,
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="academy-learners-report-${file.n}-${file.id}.csv"`,
        'x-report-sha256': file.sha256 ?? '',
        'x-report-made-at': file.finishedAt ?? '',
      },
    });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isReportsOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeReports(session, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
