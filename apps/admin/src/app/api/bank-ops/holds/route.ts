import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { founderCall } from '@/lib/desk/founder-call';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { isSendId, readHoldAction, refusalWords } from '@/lib/bank-holds/model';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Global-send holds as the signed-in founder (svc-bank `global.ops.*`). POST places a hold, asks the customer for information,
 * releases a hold or links an incoming reference; GET `?sendId=` hands over the one file a customer uploaded. The service decides
 * the permission (`admin:compliance`) and the four-eyes rule on release; this route only carries the call and says what came back.
 * A reply that never arrived is reported as unknown, never as failed, and is never sent again on its own.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const answer = (payload: Record<string, unknown>, status: number): Response => Response.json(payload, { status, headers: NO_STORE });
const accepted = (raw: unknown): { ok: true } | null => (raw && typeof raw === 'object' ? { ok: true } : null);

const parseProof = (raw: unknown): { name: string; contentBase64: string } | null => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  return r && typeof r.name === 'string' && typeof r.contentBase64 === 'string' ? { name: r.name, contentBase64: r.contentBase64 } : null;
};

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
  const input = readHoldAction(raw);
  if (!input)
    return answer(
      { ok: false, code: 'bank.personal_pay_request_invalid', message: refusalWords('bank.personal_pay_request_invalid') },
      400,
    );

  const { action, ...body } = input;
  const procedure = {
    hold: 'global.ops.hold',
    requestInfo: 'global.ops.requestInfo',
    release: 'global.ops.release',
    linkReference: 'global.ops.linkReference',
  }[action];
  const result = await founderCall(session, 'bank', procedure, 'POST', body, accepted);
  switch (result.kind) {
    case 'ok':
      return answer({ ok: true }, 200);
    case 'forbidden':
      return answer(
        {
          ok: false,
          code: result.refusal.code,
          message:
            refusalWords(result.refusal.code) ??
            'svc-bank did not accept this session for that. It needs the compliance permission (admin:compliance).',
        },
        403,
      );
    case 'refused':
      return answer({ ok: false, code: result.refusal.code, message: refusalWords(result.refusal.code) ?? result.refusal.message }, 409);
    case 'not_built':
      return answer({ ok: false, code: 'not_built', message: 'svc-bank has not switched this on for this deployment.' }, 501);
    case 'invalid':
      return answer(
        {
          ok: false,
          unknown: true,
          message: 'svc-bank answered in a shape this console does not understand. Read the queue to see what was stored.',
        },
        502,
      );
    case 'unavailable':
      return answer(
        {
          ok: false,
          unknown: result.uncertain,
          message: 'svc-bank did not answer. Read the queue to see what was stored; nothing is repeated automatically.',
        },
        503,
      );
  }
}

/**
 * The customer's file, as a download. It is customer-supplied, so it is never shown inline: it goes out as an opaque attachment
 * that the browser must not sniff, and the read is same-origin only.
 */
export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('bank-ops');
  if (disabled) return disabled;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return answer({ error: 'not_same_origin' }, 403);
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const sendId = new URL(request.url).searchParams.get('sendId');
  if (!isSendId(sendId)) return answer({ error: 'hold_request_invalid' }, 400);
  const result = await founderCall(session, 'bank', 'global.ops.proof', 'GET', { sendId }, parseProof);
  if (result.kind !== 'ok') {
    const code = result.kind === 'refused' || result.kind === 'forbidden' ? result.refusal.code : null;
    return answer(
      { ok: false, code, message: refusalWords(code) ?? 'The file could not be read.' },
      result.kind === 'forbidden' ? 403 : result.kind === 'refused' ? 409 : 502,
    );
  }
  const bytes = Buffer.from(result.data.contentBase64, 'base64');
  const name = result.data.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'proof';
  return new Response(bytes, {
    status: 200,
    headers: {
      ...NO_STORE,
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`,
      'x-content-type-options': 'nosniff',
    },
  });
}
