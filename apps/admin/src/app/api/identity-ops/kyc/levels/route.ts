import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { moduleDisabledResponse } from '@/lib/modules';
import { readKycLevelStep } from '@/lib/kyc-review/model';
import { readLevelSettings, runLevelStep } from '@/lib/kyc-review/server';

/**
 * Per-level requirements and review times (I-kyc-compliance-05, J-identity-20 #7). GET reads what is in force, what the
 * owner published and the changes waiting; POST proposes a change for one level, or approves or withdraws a waiting one.
 * Identity applies a change only when a different person approves it.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const read = await readLevelSettings(session);
  return Response.json(read, { status: read.ok ? 200 : 409, headers: NO_STORE });
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
    return Response.json({ ok: false }, { status: 400, headers: NO_STORE });
  }
  const step = readKycLevelStep(raw);
  if (!step) return Response.json({ ok: false }, { status: 400, headers: NO_STORE });
  const result = await runLevelStep(session, step);
  console.warn(
    JSON.stringify({
      audit: `admin.kyc_level_change_${step.op}`,
      at: new Date().toISOString(),
      actor: session.session.userId,
      ...(step.op === 'propose' ? { level: step.level } : { changeId: step.changeId }),
      outcome: result.ok ? 'ok' : (result.refusal.code ?? 'refused'),
    }),
  );
  return Response.json(result, { status: result.ok ? 200 : 409, headers: NO_STORE });
}
