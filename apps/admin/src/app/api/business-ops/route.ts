import { adminBffGate } from '@/lib/admin-bff-gate';
import { callBusinessOps, opsAuthority } from '@/lib/business-ops-client';
import { OPS_VIEWS, OPS_CREATES, opsCreateInput, type OpsView, type OpsCreate } from '@/lib/business-ops-contract';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const fail = (code: string, status: number) => json({ ok: false, status, code, uncertain: false }, status);

export async function GET(request: Request) {
  const gate = adminBffGate(request);
  if (gate) return gate;
  const query = new URL(request.url).searchParams;
  const view = query.get('view');
  if (view === 'authority') return json({ ok: true, status: 200, authority: opsAuthority() });
  if (!OPS_VIEWS.includes(view as OpsView)) return fail('admin.ops_unknown_view', 400);
  const input: Record<string, unknown> = {};
  if (view !== 'revenue') {
    const rawLimit = query.get('limit');
    if (!rawLimit || !/^\d+$/.test(rawLimit)) return fail('admin.ops_explicit_limit_required', 400);
    const limit = Number(rawLimit); // page count, never a monetary field
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return fail('admin.ops_explicit_limit_required', 400);
    input.limit = limit;
  }
  if (view === 'milestones' && query.get('raiseId')) input.raiseId = query.get('raiseId');
  const result = await callBusinessOps(view as OpsView, input);
  return json(result, result.status);
}

export async function POST(request: Request) {
  const gate = adminBffGate(request);
  if (gate) return gate;
  let body: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad body');
    body = raw as Record<string, unknown>;
  } catch {
    return fail('admin.ops_bad_body', 400);
  }
  if (!OPS_CREATES.includes(body.operation as OpsCreate)) return fail('admin.ops_unknown_operation', 400);
  const operation = body.operation as OpsCreate;
  if (body.acknowledged !== true || body.confirmation !== `CREATE ${operation}`) return fail('admin.ops_confirmation_required', 400);
  let input: Record<string, unknown>;
  try {
    input = opsCreateInput(operation, body.input);
  } catch {
    return fail('admin.ops_invalid_input', 400);
  }
  const result = await callBusinessOps(operation, input, true);
  return json(result, result.status);
}
