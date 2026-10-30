import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { moduleDisabledResponse } from '@/lib/modules';
import { restoreExecute } from '@/lib/restore/execute';
import { restoreWritesParked } from '@/lib/restore/treasury';

/**
 * The restore desk's two-founder requests (OPS-ledger-desk-05): record one watermark stamp, or finalize one run. Founder A proposes,
 * a different founder approves at identity, and founder A runs it; svc-ops (`restore.record`, `restore.finalize`: admin:treasury,
 * a second factor and the approval) spends the approval once. Starting a run and recording its steps stay on `/api/restore`.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['ops.restore.record', 'ops.restore.finalize'],
    // svc-ops spends an approval only for the founder who proposed it, and records the treasury credential's holder as that
    // founder, so only the holder may propose or run. Approving goes to identity as the second founder, who never holds it.
    check: (body) => {
      if (body.step !== 'propose' && body.step !== 'execute') return null;
      const parked = restoreWritesParked(session);
      return parked ? { refusal: parked, status: parked.code === 'admin.ledger_unconfigured' ? 503 : 409 } : null;
    },
    execute: restoreExecute(session),
  });
}
