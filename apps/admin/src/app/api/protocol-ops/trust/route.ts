import {
  ADDRESS_LABEL_KINDS,
  protocolComplianceReportsOutputSchema,
  protocolComplianceReviewSchema,
} from '@intafaced/contracts/protocol-address-risk';
import { protocolAuditProductsSchema } from '@intafaced/contracts/protocol-blockers';
import { tokensListOutputSchema } from '@intafaced/contracts/protocol-tokens';
import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { founderCall, parseWith, type FounderCallResult } from '@/lib/desk/founder-call';
import { trustRefusalWords } from '@/lib/protocol-trust/model';

/**
 * The Protocol trust desk (J-dex-protocol-30) as the signed-in founder: GET reads svc-protocol's compliance queue, its
 * token list and its audit rows; POST asks for a label or approves one (`compliance.labels.ask` / `.approve`). The
 * second reviewer must be a different person, which svc-protocol enforces. A reply that never arrived is reported as
 * unknown, never as failed, and is never sent again on its own.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const answer = (payload: Record<string, unknown>, status: number): Response => Response.json(payload, { status, headers: NO_STORE });

type Part<T> = { ok: true; data: T } | { ok: false; message: string };
function part<T>(result: FounderCallResult<T>, what: string): Part<T> {
  switch (result.kind) {
    case 'ok':
      return { ok: true, data: result.data };
    case 'forbidden':
      return {
        ok: false,
        message: `svc-protocol did not accept this session for the ${what}. It needs the operator read permission (admin:read).`,
      };
    case 'refused':
      return { ok: false, message: `svc-protocol refused the ${what}: ${result.refusal.code ?? result.refusal.message}.` };
    case 'not_built':
      return { ok: false, message: `svc-protocol does not serve the ${what} on this deployment.` };
    case 'invalid':
      return { ok: false, message: `svc-protocol answered the ${what} in a shape this console does not understand.` };
    case 'unavailable':
      return { ok: false, message: `svc-protocol did not answer for the ${what}.` };
  }
}

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('protocol-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const [reports, tokens, audit] = await Promise.all([
    founderCall(session, 'protocol', 'compliance.reports.list', 'GET', undefined, parseWith(protocolComplianceReportsOutputSchema)),
    founderCall(session, 'protocol', 'tokens.list', 'GET', { window: '24h' }, parseWith(tokensListOutputSchema)),
    founderCall(session, 'protocol', 'auditProducts', 'GET', undefined, parseWith(protocolAuditProductsSchema)),
  ]);
  return answer(
    {
      asOf: new Date().toISOString(),
      reports: part(reports, 'report queue'),
      tokens: part(tokens, 'token list'),
      audit: part(audit, 'audit rows'),
    },
    200,
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('protocol-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const invalid = () =>
    answer({ ok: false, code: 'admin.request_invalid', message: 'That request was not accepted. Nothing was sent.' }, 400);
  let procedure: string;
  let input: Record<string, string>;
  if (raw.op === 'ask') {
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (typeof raw.reportId !== 'string' || !UUID.test(raw.reportId)) return invalid();
    if (!(ADDRESS_LABEL_KINDS as readonly unknown[]).includes(raw.kind) || reason.length === 0 || reason.length > 500) return invalid();
    procedure = 'compliance.labels.ask';
    input = { reportId: raw.reportId, kind: raw.kind as string, reason };
  } else if (raw.op === 'approve') {
    if (typeof raw.reviewId !== 'string' || !UUID.test(raw.reviewId)) return invalid();
    procedure = 'compliance.labels.approve';
    input = { reviewId: raw.reviewId };
  } else return invalid();

  const result = await founderCall(session, 'protocol', procedure, 'POST', input, parseWith(protocolComplianceReviewSchema));
  switch (result.kind) {
    case 'ok':
      return answer({ ok: true, review: result.data }, 200);
    case 'forbidden':
      return answer(
        {
          ok: false,
          code: result.refusal.code,
          message: 'svc-protocol did not accept this session for that. It needs the operator write permission (admin:write).',
        },
        403,
      );
    case 'refused':
      return answer(
        { ok: false, code: result.refusal.code, message: trustRefusalWords(result.refusal.code) ?? 'svc-protocol refused this.' },
        409,
      );
    case 'not_built':
      return answer({ ok: false, code: 'not_built', message: 'svc-protocol does not serve this on this deployment.' }, 501);
    case 'invalid':
      return answer(
        {
          ok: false,
          unknown: true,
          message: 'svc-protocol answered in a shape this console does not understand. Reload to see what is stored.',
        },
        502,
      );
    case 'unavailable':
      return answer(
        {
          ok: false,
          unknown: result.uncertain,
          message: 'svc-protocol did not answer. Reload to see what is stored; nothing is repeated automatically.',
        },
        503,
      );
  }
}
