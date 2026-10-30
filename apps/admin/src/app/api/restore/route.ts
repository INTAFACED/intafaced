import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { founderCall } from '@/lib/desk/founder-call';
import { RESTORE_NO, refusalWords, startKey, stepKey } from '@/lib/restore/model';

/**
 * Restore desk writes as the signed-in founder: start a run, record a step (svc-ops `restore.*`). Stamps and finalize need a
 * second founder, so they go through `/api/restore/approvals`. The keys are business
 * keys built here from the restore number and step, so a repeated press or a retry returns the stored row. svc-ops decides the
 * order, the joint check and the second founder; this route only carries the call and says what came back. A reply that never
 * arrived is reported as unknown, never as failed, and is never sent again on its own.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

type Body =
  | { action: 'start'; restoreNo: string; cutOff: string }
  | { action: 'step'; restoreNo: string; step: 'restore_clean' | 'validate' | 'preview' };

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' && v.trim().length <= max ? v.trim() : null;

function parseBody(raw: Record<string, unknown>): Body | null {
  const restoreNo = text(raw.restoreNo, 64);
  if (!restoreNo || !RESTORE_NO.test(restoreNo)) return null;
  if (raw.action === 'start') {
    const cutOff = text(raw.cutOff, 40);
    return cutOff && !Number.isNaN(Date.parse(cutOff)) ? { action: 'start', restoreNo, cutOff: new Date(cutOff).toISOString() } : null;
  }
  if (raw.action === 'step') {
    return raw.step === 'restore_clean' || raw.step === 'validate' || raw.step === 'preview'
      ? { action: 'step', restoreNo, step: raw.step }
      : null;
  }
  return null;
}

const accepted = (raw: unknown): { ok: true } | null => (raw && typeof raw === 'object' ? { ok: true } : null);

function answer(payload: Record<string, unknown>, status: number): Response {
  return Response.json(payload, { status, headers: NO_STORE });
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
  const input = parseBody(raw);
  if (!input) return answer({ ok: false, code: 'admin.request_invalid', message: 'That request was not accepted. Nothing was sent.' }, 400);

  const result =
    input.action === 'start'
      ? await founderCall(
          session,
          'ops',
          'restore.start',
          'POST',
          { restoreNo: input.restoreNo, cutOff: input.cutOff, idempotencyKey: startKey(input.restoreNo) },
          accepted,
        )
      : await founderCall(
          session,
          'ops',
          'restore.step',
          'POST',
          { restoreNo: input.restoreNo, step: input.step, idempotencyKey: stepKey(input.restoreNo, input.step) },
          accepted,
        );
  switch (result.kind) {
    case 'ok':
      return answer({ ok: true }, 200);
    case 'forbidden':
      return answer(
        {
          ok: false,
          code: result.refusal.code,
          message: refusalWords(result.refusal.code) ?? 'svc-ops did not accept this session for that. It needs the treasury permission.',
        },
        403,
      );
    case 'refused':
      return answer({ ok: false, code: result.refusal.code, message: refusalWords(result.refusal.code) ?? 'svc-ops refused this.' }, 409);
    case 'not_built':
      return answer({ ok: false, code: 'not_built', message: 'svc-ops has not switched this on for this deployment.' }, 501);
    case 'invalid':
      return answer(
        {
          ok: false,
          unknown: true,
          message: 'svc-ops answered in a shape this console does not understand. Reload to see what was stored.',
        },
        502,
      );
    case 'unavailable':
      return answer(
        {
          ok: false,
          unknown: result.uncertain,
          message: 'svc-ops did not answer. Reload to see what was stored; nothing is repeated automatically.',
        },
        503,
      );
  }
}
