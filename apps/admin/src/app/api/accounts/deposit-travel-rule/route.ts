import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { readTravelRuleRequest } from '@/lib/deposit-travel-rule/model';
import { actOnTravelRule } from '@/lib/deposit-travel-rule/server';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { refusalResponse, stepResponse } from '@/lib/desk/step-route';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * One founder's step on a deposit held for the inbound travel rule (J-wallet-03 #2-#3): wait on the sending platform, or release
 * a declared deposit so svc-pay credits it once. Each takes a reason, kept on the deposit's travel-rule history.
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
  const body = readTravelRuleRequest(raw);
  if (body === null) return refusalResponse('execute', explainRefusal('admin.request_invalid', 400, false), 400);
  const reply = await actOnTravelRule(session, body);
  console.warn(
    JSON.stringify({
      audit: `admin.deposit_travel_rule.${body.action}`,
      at: new Date().toISOString(),
      founder: session.session.userId,
      target: body.depositId,
      ok: reply.ok,
      code: reply.ok ? null : reply.refusal.code,
    }),
  );
  return stepResponse(
    reply.ok ? { ok: true, step: 'execute', detail: reply.detail } : { ok: false, step: 'execute', refusal: reply.refusal },
  );
}
