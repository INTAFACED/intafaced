import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { readFreezeRequest } from '@/lib/deposit-freezes/model';
import { freezeDepositAddress } from '@/lib/deposit-freezes/server';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { refusalResponse, stepResponse } from '@/lib/desk/step-route';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Freeze one customer deposit address for a compliance review (J-wallet-03 #4). One founder with a reason: svc-pay holds every
 * deposit to it that is not credited yet, and posts nothing. Lifting it is `/api/accounts/deposit-unfreeze`, with a second founder.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const body = readFreezeRequest(raw);
  if (body === null) return refusalResponse('execute', explainRefusal('admin.request_invalid', 400, false), 400);
  const reply = await freezeDepositAddress(session, body);
  console.warn(
    JSON.stringify({
      audit: 'admin.deposit_address.freeze',
      at: new Date().toISOString(),
      founder: session.session.userId,
      target: body.userId,
      ok: reply.ok,
      code: reply.ok ? null : reply.refusal.code,
    }),
  );
  return stepResponse(
    reply.ok ? { ok: true, step: 'execute', detail: reply.detail } : { ok: false, step: 'execute', refusal: reply.refusal },
  );
}
