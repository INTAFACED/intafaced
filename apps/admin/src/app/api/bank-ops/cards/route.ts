import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { founderCall } from '@/lib/desk/founder-call';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { readAction, refusalCode, refusalWords } from '@/lib/card-programme/model';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Card programme steps as the signed-in founder (svc-bank `ops.cardProgramme*`, J-bank-26): settings, rules, 3DS, staff,
 * cardholders, bulk issue, reassign, the TEST simulator and the signed export. svc-bank decides the permission
 * (`support:ops`, or `admin:read` for the export), the staff role and every field; this route carries the call and says what
 * came back. A reply that never arrived is reported as unknown and is never sent again on its own.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const answer = (payload: Record<string, unknown>, status: number): Response => Response.json(payload, { status, headers: NO_STORE });

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('bank-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const step = readAction(raw);
  if (!step) return answer({ ok: false, code: 'bank.card_programme_invalid', message: refusalWords('bank.card_programme_invalid') }, 400);
  const result = await founderCall(session, 'bank', step.procedure, 'POST', step.body, (d) => (d === undefined ? null : { data: d }));
  switch (result.kind) {
    case 'ok':
      return answer({ ok: true, data: result.data.data }, 200);
    case 'forbidden': {
      const code = refusalCode(result.refusal.code, result.refusal.message);
      return answer(
        {
          ok: false,
          code,
          message: refusalWords(code) ?? 'svc-bank did not accept this session for that. It needs the support permission (support:ops).',
        },
        403,
      );
    }
    case 'refused': {
      const code = refusalCode(result.refusal.code, result.refusal.message);
      return answer({ ok: false, code, message: result.refusal.message || refusalWords(code) }, 409);
    }
    case 'not_built':
      return answer({ ok: false, code: 'not_built', message: 'svc-bank has not switched this on for this deployment.' }, 501);
    case 'invalid':
      return answer(
        { ok: false, unknown: true, message: 'svc-bank answered in a shape this console does not understand. Read the desk again.' },
        502,
      );
    case 'unavailable':
      return answer(
        {
          ok: false,
          unknown: result.uncertain,
          message: 'svc-bank did not answer. Read the desk to see what was stored; nothing is repeated automatically.',
        },
        503,
      );
  }
}
