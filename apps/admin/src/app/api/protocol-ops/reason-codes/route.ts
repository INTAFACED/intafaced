import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { founderCall } from '@/lib/desk/founder-call';
import { parseReasonCodeLines, reasonCodeRefusalWords } from '@/lib/protocol-listing/model';

/**
 * Replace the list of reasons a hide or delist may name (svc-ops `protocolListing.reasonCodes.set`). One admin acts; svc-ops needs
 * the operator write permission and logs who made the change. A reply that never arrived is reported as unknown, never as failed,
 * and is never sent again on its own.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const answer = (payload: Record<string, unknown>, status: number): Response => Response.json(payload, { status, headers: NO_STORE });
const accepted = (raw: unknown): { ok: true } | null => (raw && typeof raw === 'object' ? { ok: true } : null);

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
  const read =
    Array.isArray(raw.codes) && raw.codes.every((c) => typeof c === 'string') ? parseReasonCodeLines(raw.codes.join('\n')) : null;
  if (!read?.ok) {
    return answer(
      { ok: false, code: 'admin.request_invalid', message: read ? read.problem : 'That request was not accepted. Nothing was sent.' },
      400,
    );
  }

  const result = await founderCall(session, 'ops', 'protocolListing.reasonCodes.set', 'POST', { codes: read.codes }, accepted);
  switch (result.kind) {
    case 'ok':
      return answer({ ok: true }, 200);
    case 'forbidden':
      return answer(
        {
          ok: false,
          code: result.refusal.code,
          message: 'svc-ops did not accept this session for that. It needs the operator write permission (admin:write).',
        },
        403,
      );
    case 'refused':
      return answer(
        { ok: false, code: result.refusal.code, message: reasonCodeRefusalWords(result.refusal.code) ?? 'svc-ops refused this.' },
        409,
      );
    case 'not_built':
      return answer({ ok: false, code: 'not_built', message: 'svc-ops has not switched this on for this deployment.' }, 501);
    case 'invalid':
      return answer(
        {
          ok: false,
          unknown: true,
          message: 'svc-ops answered in a shape this console does not understand. Reload to see what is stored.',
        },
        502,
      );
    case 'unavailable':
      return answer(
        {
          ok: false,
          unknown: result.uncertain,
          message: 'svc-ops did not answer. Reload to see what is stored; nothing is repeated automatically.',
        },
        503,
      );
  }
}
