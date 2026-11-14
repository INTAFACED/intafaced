import { adminBffSession } from '@/lib/admin-bff-gate';
import { moduleDisabledResponse } from '@/lib/modules';
import { reportFile } from '@/lib/academy/enrolment-server';

/**
 * A finished learner export (J-academy-15 #7) as the CSV file svc-academy stored, with its SHA-256 in a header, so the
 * download can be checked against the hash the page shows. An unfinished or expired export answers its refusal.
 *
 *   GET ?id=<task>
 */

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) return Response.json({ ok: false, title: 'Which report?', code: null }, { status: 400 });
  const answer = await reportFile(session, id);
  if (!('file' in answer)) return Response.json(answer.reply, { status: answer.status, headers: { 'cache-control': 'no-store' } });
  return new Response(answer.file.csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="learner-export-${id}.csv"`,
      'x-content-sha256': answer.file.sha256 ?? '',
      'cache-control': 'no-store',
    },
  });
}
