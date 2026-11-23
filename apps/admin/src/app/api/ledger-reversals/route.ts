import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { failureRefusal } from '@/lib/desk';
import { explainRefusal } from '@/lib/refusal-copy';
import { LOOKUP_TX_ID } from '@/lib/ledger-lookup';
import { readReversals, requestReversal, reversalWritesParked } from '@/lib/ledger-reversals';
import { reversalAsk } from '@/lib/ledger-reversals/model';

/**
 * Operator reversals of one posted ledger transaction (J-ops-console-05 #1-#3, OPS-ledger-desk-02).
 *
 * GET `?txId=` reads svc-ops' reversal requests for that transaction as the signed-in founder, with whether this founder can ask
 * or run one here. POST `{ txId, reason, caseRef }` asks svc-ops to reverse it: svc-ops writes the intent row and nothing posts
 * until a different founder approves (`/api/ledger-reversals/approve`). A refusal as already reversed comes back with the first
 * reversal.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const txIdOf = (value: unknown) => (typeof value === 'string' && LOOKUP_TX_ID.test(value.trim()) ? value.trim().toLowerCase() : null);

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const txId = params.size === 1 ? txIdOf(params.get('txId')) : null;
  if (!txId)
    return Response.json({ ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) }, { status: 400, headers: NO_STORE });
  const result = await readReversals(session, txId);
  if (result.kind !== 'ok') {
    const reply = failureRefusal('svc-ops', 'ops', result);
    return Response.json(
      { ok: false, refusal: reply.ok ? null : reply.refusal },
      { status: result.kind === 'forbidden' ? 403 : 502, headers: NO_STORE },
    );
  }
  if (result.data.reversals.some((r) => r.originalTxId !== txId))
    return Response.json(
      { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) },
      { status: 502, headers: NO_STORE },
    );
  return Response.json({ ok: true, list: result.data, writes: reversalWritesParked(session) }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let body: Record<string, unknown>;
  try {
    body = await readAdminJson(request);
  } catch {
    return Response.json({ ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) }, { status: 400, headers: NO_STORE });
  }
  const txId = txIdOf(body.txId);
  const ask = reversalAsk(typeof body.reason === 'string' ? body.reason : '', typeof body.caseRef === 'string' ? body.caseRef : '');
  if (!txId || !ask.ok)
    return Response.json(
      { ok: false, refusal: { ...explainRefusal('admin.request_invalid', 400, false), ...(ask.ok ? {} : { body: ask.why }) } },
      { status: 400, headers: NO_STORE },
    );
  const answer = await requestReversal(session, { originalTxId: txId, reason: ask.reason, caseRef: ask.caseRef });
  if (answer.ok) return Response.json(answer, { headers: NO_STORE });
  const status = answer.refusal.code === 'ops.reversal_already_reversed' ? 409 : answer.refusal.changed === 'unknown' ? 502 : 409;
  return Response.json(answer, { status, headers: NO_STORE });
}
