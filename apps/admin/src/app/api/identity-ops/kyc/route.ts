import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { moduleDisabledResponse } from '@/lib/modules';
import { readKycReviewStep, UUID } from '@/lib/kyc-review/model';
import { readKycCapabilities, readKycCase, readKycQueue, runKycReviewStep } from '@/lib/kyc-review/server';

/**
 * The verification review queue (I-kyc-compliance-02, J-identity-20 #1 #2). GET reads one page of open cases
 * (`?cursor=` for the next one) or one case (`?caseId=`); POST claims or releases a case, or adds an internal note. Every
 * call runs as the signed-in person: identity checks the compliance permission and the second factor, and takes the
 * reviewer from the session.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

function reply(body: { ok: boolean }, status = body.ok ? 200 : 409): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const capabilitiesFor = params.get('capabilitiesFor');
  if (capabilitiesFor !== null) {
    if (!UUID.test(capabilitiesFor)) return reply({ ok: false }, 400);
    return reply(await readKycCapabilities(session, capabilitiesFor));
  }
  const caseId = params.get('caseId');
  if (caseId !== null) {
    if (!UUID.test(caseId)) return reply({ ok: false }, 400);
    return reply(await readKycCase(session, caseId));
  }
  const cursor = params.get('cursor');
  return reply(await readKycQueue(session, cursor && cursor.length <= 200 ? cursor : null));
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let raw: unknown;
  try {
    raw = await readAdminJson(request);
  } catch {
    return reply({ ok: false }, 400);
  }
  const step = readKycReviewStep(raw);
  if (!step) return reply({ ok: false }, 400);
  const result = await runKycReviewStep(session, step);
  // The audit line names who did what to which case. It never carries a note's words.
  console.warn(
    JSON.stringify({
      audit:
        step.op === 'assign'
          ? `admin.kyc_case_${step.action}`
          : step.op === 'rfi'
            ? 'admin.kyc_case_info_requested'
            : step.op === 'appeal'
              ? `admin.kyc_appeal_${step.decision}`
              : 'admin.kyc_case_note',
      at: new Date().toISOString(),
      actor: session.session.userId,
      caseId: step.caseId,
      outcome: result.ok ? 'ok' : (result.refusal.code ?? 'refused'),
    }),
  );
  return reply(result);
}
