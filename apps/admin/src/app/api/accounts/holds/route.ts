import { staffHoldListInputSchema } from '@intafaced/contracts/ops-staff-holds';
import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { holdExecute, holdWritesParked, readHolds } from '@/lib/accounts/holds-server';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { handleStep } from '@/lib/desk/step-route';

/**
 * Staff holds on one customer's funds (J-ops-console-04 #2-#5, OPS-accounts-desk-01).
 *
 * GET `?id=` reads svc-ops' holds for the account as the signed-in founder, with whether this founder can act on them here.
 * POST runs one step of a two-founder release or confirm: the first founder proposes at identity, a different founder approves
 * the same hold and amount, and the run goes to svc-ops on the treasury transport, which spends the approval once.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const userId = params.get('id')?.toLowerCase() ?? '';
  if (params.size !== 1 || !staffHoldListInputSchema.safeParse({ userId }).success)
    return Response.json(
      { ok: false, code: 'admin.accounts_input', message: 'Give one platform user id.' },
      { status: 400, headers: NO_STORE },
    );
  const result = await readHolds(session, userId);
  if (result.kind !== 'ok') {
    const reply = failureRefusal('svc-ops', 'ops', result);
    const refusal = reply.ok ? null : reply.refusal;
    return Response.json({ ok: false, refusal }, { status: result.kind === 'forbidden' ? 403 : 502, headers: NO_STORE });
  }
  if (result.data.holds.some((h) => h.userId !== userId))
    return Response.json({ ok: false, refusal: null }, { status: 502, headers: NO_STORE });
  return Response.json({ ok: true, list: result.data, writes: holdWritesParked(session) }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['ops.hold.release', 'ops.hold.confirm'],
    // svc-ops spends an approval only for the founder who proposed it, and records the treasury credential's holder as that
    // founder, so only the holder may propose or run. Approving goes to identity as the second founder, who never holds it.
    check: (body) => {
      if (body.step !== 'propose' && body.step !== 'execute') return null;
      const parked = holdWritesParked(session);
      return parked ? { refusal: parked, status: 409 } : null;
    },
    execute: holdExecute(session),
  });
}
