import {
  opsAlertAcknowledgeInputSchema,
  opsAlertDetailSchema,
  opsAlertSnoozeInputSchema,
  opsAlertUnsnoozeInputSchema,
} from '@intafaced/contracts/ops-reconciliation-alerts';
import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { founderCall, parseWith } from '@/lib/desk/founder-call';
import { UUID, alertKey, refusalWords, type AlertAction } from '@/lib/recon-alerts/model';

/**
 * Reconciliation alert writes as the signed-in founder (svc-ops `alerts.acknowledge|snooze|unsnooze`, OPS-reconciliation-03).
 * The key is a business key built here from the move, the alert, the version the founder saw and the founder's own user id,
 * so a retry returns the stored result and two founders acting at once never share a key: svc-ops lets one win and refuses
 * the other with `ops.alert_state_illegal`. A reply that never arrived is reported as unknown and never sent again on its own.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const answer = (payload: Record<string, unknown>, status: number): Response => Response.json(payload, { status, headers: NO_STORE });

const PROCEDURE: Readonly<Record<AlertAction, string>> = {
  acknowledge: 'alerts.acknowledge',
  snooze: 'alerts.snooze',
  unsnooze: 'alerts.unsnooze',
};

function parseBody(raw: Record<string, unknown>, userId: string): { action: AlertAction; input: unknown } | null {
  const action = raw.action;
  if (action !== 'acknowledge' && action !== 'snooze' && action !== 'unsnooze') return null;
  if (typeof raw.alertId !== 'string' || !UUID.test(raw.alertId)) return null;
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) return null;
  const alertId = raw.alertId.toLowerCase();
  const idempotencyKey = alertKey(action, alertId, raw.version, userId);
  const schema =
    action === 'acknowledge'
      ? opsAlertAcknowledgeInputSchema
      : action === 'snooze'
        ? opsAlertSnoozeInputSchema
        : opsAlertUnsnoozeInputSchema;
  const input =
    action === 'acknowledge'
      ? { alertId, note: typeof raw.note === 'string' ? raw.note : '', idempotencyKey }
      : action === 'snooze'
        ? {
            alertId,
            endsAt: typeof raw.endsAt === 'string' && !Number.isNaN(Date.parse(raw.endsAt)) ? new Date(raw.endsAt).toISOString() : '',
            ...(typeof raw.reason === 'string' && raw.reason.trim() ? { reason: raw.reason.trim() } : {}),
            idempotencyKey,
          }
        : { alertId, idempotencyKey };
  const parsed = schema.safeParse(input);
  return parsed.success ? { action, input: parsed.data } : null;
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const body = parseBody(raw, session.session.userId);
  if (!body) return answer({ ok: false, code: 'admin.alert_input', message: 'That alert request is not one this console sends.' }, 400);

  const result = await founderCall(session, 'ops', PROCEDURE[body.action], 'POST', body.input, parseWith(opsAlertDetailSchema));
  switch (result.kind) {
    case 'ok':
      return answer({ ok: true, alert: result.data.alert }, 200);
    case 'forbidden':
      return answer(
        {
          ok: false,
          code: result.refusal.code,
          message:
            refusalWords(result.refusal.code) ?? 'svc-ops did not accept this session for that. It needs admin:write and a second factor.',
        },
        403,
      );
    case 'refused':
      return answer({ ok: false, code: result.refusal.code, message: refusalWords(result.refusal.code) ?? 'svc-ops refused this.' }, 409);
    case 'not_built':
      return answer({ ok: false, code: 'not_built', message: 'svc-ops has not switched this on for this deployment.' }, 501);
    case 'invalid':
      return answer(
        { ok: false, unknown: true, message: 'svc-ops answered in a shape this console does not read. Reload to see what was stored.' },
        502,
      );
    case 'unavailable':
      return answer(
        result.uncertain
          ? { ok: false, unknown: true, message: 'svc-ops did not answer, so the outcome is unknown. Reload to see what was stored.' }
          : { ok: false, message: 'svc-ops did not answer. Nothing was changed.' },
        503,
      );
  }
}
