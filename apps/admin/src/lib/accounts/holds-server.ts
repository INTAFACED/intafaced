import 'server-only';
import { staffHoldListSchema, staffHoldResultSchema, type StaffHoldList, type StaffHoldResult } from '@intafaced/contracts/ops-staff-holds';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { edgeCall, founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import { treasuryTransport } from '@/lib/ledger/reconciliation-server';
import { failureRefusal } from '@/lib/ops-desk/execute';
import type { PlaceForm } from './holds';

/**
 * The console's hops to svc-ops' staff holds (OPS-accounts-desk-01, J-ops-console-04 #2-#5).
 *
 * The list goes as the signed-in founder (`admin:read`). Place, release and confirm move value, so svc-ops asks for
 * `admin:treasury`, which a founder session never carries: they go on the treasury transport (`ADMIN_TREASURY_TOKEN`), as the
 * posting freeze and the reconciliation run do. svc-ops records the credential's holder as the one who asked, and spends a
 * release or confirm approval only for the founder who proposed it, so this console sends a hold action only while the
 * signed-in founder is that holder, and otherwise says so and sends nothing.
 */

/** The founder a treasury credential was issued to (its `userId` or `sub`), or null when it names none this console can read. */
export function treasuryHolder(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown; userId?: unknown };
    const sub = typeof claims.userId === 'string' ? claims.userId : claims.sub;
    return typeof sub === 'string' ? sub.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Why this founder cannot act on holds from this console, or null when they can. */
export function holdWritesParked(ctx: FounderCallContext): RefusalView | null {
  const transport = treasuryTransport();
  if ('reason' in transport) return { ...explainRefusal('admin.ledger_unconfigured', 503, false), body: transport.reason };
  const holder = treasuryHolder(transport.token);
  if (holder === null)
    return {
      title: 'This console cannot tell whose treasury credential it holds',
      body: 'svc-ops records the founder the treasury credential belongs to as the one who placed, released or confirmed a hold, and this console cannot read that founder from the credential. Nothing is sent rather than record an action under a name nobody checked.',
      next: 'Issue the console a treasury credential that names its founder (a signed token with their id).',
      code: 'admin.treasury_holder_unreadable',
      changed: 'no',
    };
  if (holder !== ctx.session.userId.toLowerCase())
    return {
      title: 'Holds go out under the treasury credential, which is not yours',
      body: 'svc-ops records the founder the treasury credential belongs to as the one who placed, released or confirmed a hold. That is another founder on this console, so nothing is sent rather than record your action under their name.',
      next: 'Ask the founder who holds the treasury credential to do this step, or have it issued to you.',
      code: 'admin.treasury_holder_mismatch',
      changed: 'no',
    };
  return null;
}

async function treasuryOps<T>(procedure: string, input: unknown, parse: (raw: unknown) => T | null): Promise<FounderCallResult<T>> {
  const transport = treasuryTransport();
  if ('reason' in transport) return { kind: 'unavailable', uncertain: false, requestId: null };
  return edgeCall(transport, 'ops', procedure, 'POST', input, parse, { timeoutMs: 20_000 });
}

export async function readHolds(ctx: FounderCallContext, userId: string): Promise<FounderCallResult<StaffHoldList>> {
  return founderCall(ctx, 'ops', 'staffHolds.list', 'GET', { userId }, parseWith(staffHoldListSchema));
}

/** What a hold action's answer proves, in words. `settling` is never a success: the ledger has not answered yet. */
export function holdReply(result: StaffHoldResult, holdNo: string | null, verb: string): ExecuteReply {
  if (holdNo !== null && result.hold.holdNo !== holdNo)
    return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  if (result.outcome === 'settling')
    return {
      ok: false,
      refusal: {
        title: 'The ledger has not answered yet',
        body: `svc-ops stored the ${verb} and sent it, but the ledger's answer did not come back. svc-ops reads the ledger by key until it knows, and never sends a second one.`,
        next: 'Read the holds again in a minute. Do not ask again.',
        code: null,
        changed: 'unknown',
      },
    };
  const left = `${result.hold.remaining} ${result.hold.assetId}`;
  return {
    ok: true,
    detail: `${result.outcome === 'replayed' ? 'Already done: ' : ''}hold ${result.hold.holdNo} is ${result.hold.state.replace(/_/g, ' ')}, ${left} still held.`,
  };
}

export async function placeHold(ctx: FounderCallContext, form: PlaceForm): Promise<ExecuteReply> {
  const parked = holdWritesParked(ctx);
  if (parked) return { ok: false, refusal: parked };
  const result = await treasuryOps('staffHolds.place', form, parseWith(staffHoldResultSchema));
  if (result.kind !== 'ok') return failureRefusal('svc-ops', 'ops', result);
  if (result.data.hold.userId !== form.userId) return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  return holdReply(result.data, null, 'hold');
}

/** Run an approved release or confirm on the treasury transport; svc-ops spends the approval once. */
export function holdExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'ops.hold.release' && request.kind !== 'ops.hold.confirm')
      return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const parked = holdWritesParked(ctx);
    if (parked) return { ok: false, refusal: parked };
    const result =
      request.kind === 'ops.hold.release'
        ? await treasuryOps(
            'staffHolds.release',
            { holdNo: request.holdNo, amount: request.amount, approvalId: ids.approvalId, operationId: ids.operationId },
            parseWith(staffHoldResultSchema),
          )
        : await treasuryOps(
            'staffHolds.confirm',
            { holdNo: request.holdNo, approvalId: ids.approvalId, operationId: ids.operationId },
            parseWith(staffHoldResultSchema),
          );
    if (result.kind !== 'ok') return failureRefusal('svc-ops', 'ops', result);
    if (result.data.hold.userId !== request.userId) return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
    return holdReply(result.data, request.holdNo, request.kind === 'ops.hold.release' ? 'release' : 'confirm');
  };
}
