import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { readDisputeAction, refusalCode, refusalWords, type DisputeAction } from '@/lib/card-disputes/model';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Card dispute steps as the signed-in founder (svc-bank `ops.cardDispute*`, J-bank-27): add evidence, submit a
 * representment, escalate to arbitration, ask the partner's provisional credit, decide and close. The service decides the
 * permission (`support:ops`), the state rules and the owner's dispute cap; this route only carries the call and says what
 * came back. A reply that never arrived is reported as unknown, never as failed, and is never sent again on its own.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const answer = (payload: Record<string, unknown>, status: number): Response => Response.json(payload, { status, headers: NO_STORE });
const accepted = (raw: unknown): { ok: true } | null => (raw && typeof raw === 'object' ? { ok: true } : null);

/** One dispute step, each to its own svc-bank call with only the fields that step takes. */
function sendStep(session: FounderCallContext, input: DisputeAction) {
  switch (input.action) {
    case 'evidence':
      return founderCall(
        session,
        'bank',
        'ops.cardDisputeEvidence',
        'POST',
        { disputeId: input.disputeId, stepKey: input.stepKey, description: input.description },
        accepted,
      );
    case 'representment':
      return founderCall(
        session,
        'bank',
        'ops.cardDisputeRepresentment',
        'POST',
        { disputeId: input.disputeId, stepKey: input.stepKey, description: input.description },
        accepted,
      );
    case 'arbitration':
      return founderCall(
        session,
        'bank',
        'ops.cardDisputeArbitration',
        'POST',
        { disputeId: input.disputeId, stepKey: input.stepKey },
        accepted,
      );
    case 'credit':
      return founderCall(session, 'bank', 'ops.cardDisputeCredit', 'POST', { disputeId: input.disputeId }, accepted);
    case 'decide':
      return founderCall(
        session,
        'bank',
        'ops.cardDisputeDecide',
        'POST',
        { disputeId: input.disputeId, outcome: input.outcome },
        accepted,
      );
  }
}

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
  const input = readDisputeAction(raw);
  if (!input) return answer({ ok: false, code: 'bank.card_dispute_invalid', message: refusalWords('bank.card_dispute_invalid') }, 400);
  const result = await sendStep(session, input);
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
            'svc-bank did not accept this session for that. It needs the support permission (support:ops).',
        },
        403,
      );
    case 'refused': {
      const code = refusalCode(result.refusal.code, result.refusal.message);
      return answer({ ok: false, code, message: refusalWords(code) ?? result.refusal.message }, 409);
    }
    case 'not_built':
      return answer({ ok: false, code: 'not_built', message: 'svc-bank has not switched this on for this deployment.' }, 501);
    case 'invalid':
      return answer(
        {
          ok: false,
          unknown: true,
          message: 'svc-bank answered in a shape this console does not understand. Read the case to see what was stored.',
        },
        502,
      );
    case 'unavailable':
      return answer(
        {
          ok: false,
          unknown: result.uncertain,
          message: 'svc-bank did not answer. Read the case to see what was stored; nothing is repeated automatically.',
        },
        503,
      );
  }
}
