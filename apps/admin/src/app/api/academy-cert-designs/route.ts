import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeCertDesk, isCertDeskOp, loadCertDesigns, loadCertExportFile, loadIssuedCerts } from '@/lib/academy/cert-designs-server';

/**
 * Certificate designs and the issued-certificates list (AC-certificates-03).
 *
 *   GET ?view=designs   every published certificate with its design and issued counts by revision
 *   GET ?view=issued[&certificate=<id>]   counts by certificate and status, the newest issued rows and the stored exports
 *   GET ?export=<n>   stored export n as a CSV download, with its SHA-256
 *   POST { op: 'saveDesign', certId, revision, title, body, signatories, disclaimer, language, size, effortHours, reason }
 *   POST { op: 'activateDesign', certId, revision, reason }
 *   POST { op: 'makeExport', n }   stores export n: the whole issued list now, with its time and hash
 *
 * Founder-only. svc-academy records the founder from their own token.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const CERT_ID = /^[a-z0-9:_-]{1,64}$/;

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
  const params = new URL(request.url).searchParams;
  try {
    const n = params.get('export');
    if (n !== null) {
      if (!/^[1-9]\d{0,8}$/.test(n)) return incomplete('Which export?');
      const read = await loadCertExportFile(session, Number(n));
      if (!('file' in read)) return Response.json(read.reply, { status: read.status, headers: NO_STORE });
      // The stored snapshot, byte for byte: the hash the page shows is the hash of this body.
      return new Response(read.file.csv, {
        headers: {
          ...NO_STORE,
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="issued-certificates-${read.file.n}.csv"`,
          'x-report-sha256': read.file.sha256,
        },
      });
    }
    if (params.get('view') === 'designs') return Response.json(await loadCertDesigns(session), { headers: NO_STORE });
    if (params.get('view') === 'issued') {
      const certificate = params.get('certificate');
      if (certificate !== null && !CERT_ID.test(certificate)) return incomplete('Which certificate?');
      return Response.json(await loadIssuedCerts(session, certificate), { headers: NO_STORE });
    }
    return incomplete('Which view: designs or issued?');
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
    if (!isCertDeskOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeCertDesk(session, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
