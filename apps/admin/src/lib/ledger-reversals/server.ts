import 'server-only';
import {
  OPS_LEDGER_REVERSALS_EXECUTE,
  OPS_LEDGER_REVERSALS_LIST,
  OPS_LEDGER_REVERSALS_REQUEST,
} from '@intafaced/contracts/ops-ledger-reversals-procedures';
import type { OpsLedgerReversal, OpsReversalList } from '@intafaced/contracts/ops-ledger-reversals';
import { treasuryHolder } from '@/lib/accounts';
import {
  edgeCall,
  type ExecuteFn,
  type ExecuteReply,
  explainRefusal,
  failureRefusal,
  type FounderCallContext,
  type FounderCallResult,
  founderRecordCall,
  parseWith,
  type RefusalView,
} from '@/lib/desk';
import { treasuryTransport } from '@/lib/ledger';
import { firstReversalOf, type FirstReversal } from './model';

/**
 * The console's hops to svc-ops' operator reversals (OPS-ledger-desk-02, J-ops-console-05 #1-#3).
 *
 * The list goes as the signed-in founder (`admin:read`). Asking and running move value, so svc-ops asks for `admin:treasury`,
 * which a founder session never carries: they go on the treasury transport. svc-ops records the credential's holder as the one
 * who asked, and runs a request only for the one who asked it, so this console sends them only while the signed-in founder is
 * that holder, and otherwise says so and sends nothing. Approving goes to identity as the second founder.
 */

const LIST_LIMIT = 20;

/** Why this founder cannot ask for or run a reversal from this console, or null when they can. */
export function reversalWritesParked(ctx: FounderCallContext): RefusalView | null {
  const transport = treasuryTransport();
  if ('reason' in transport) return { ...explainRefusal('admin.ledger_unconfigured', 503, false), body: transport.reason };
  const holder = treasuryHolder(transport.token);
  if (holder === null)
    return {
      title: 'This console cannot tell whose treasury credential it holds',
      body: 'svc-ops records the founder the treasury credential belongs to as the one who asked for a reversal, and this console cannot read that founder from the credential. Nothing is sent rather than record a reversal under a name nobody checked.',
      next: 'Issue the console a treasury credential that names its founder (a signed token with their id).',
      code: 'admin.treasury_holder_unreadable',
      changed: 'no',
    };
  if (holder !== ctx.session.userId.toLowerCase())
    return {
      title: 'Reversals go out under the treasury credential, which is not yours',
      body: 'svc-ops records the founder the treasury credential belongs to as the one who asked for a reversal. That is another founder on this console, so nothing is sent rather than record your reversal under their name.',
      next: 'Ask the founder who holds the treasury credential to do this step, or have it issued to you. You can still approve their request.',
      code: 'admin.treasury_holder_mismatch',
      changed: 'no',
    };
  return null;
}

/** One write on the treasury transport by its record: the record checks the input before it leaves and parses the reply. */
async function treasuryWrite(
  record: typeof OPS_LEDGER_REVERSALS_REQUEST | typeof OPS_LEDGER_REVERSALS_EXECUTE,
  input: unknown,
): Promise<FounderCallResult<OpsLedgerReversal>> {
  const transport = treasuryTransport();
  if ('reason' in transport) return { kind: 'unavailable', uncertain: false, requestId: null };
  const checked = record.input.safeParse(input);
  if (!checked.success)
    return {
      kind: 'refused',
      refusal: { code: null, message: 'The request was not in the shape svc-ops takes.', status: 400 },
      requestId: null,
    };
  return edgeCall(transport, 'ops', record.path, 'POST', checked.data, parseWith(record.output), { timeoutMs: 20_000 });
}

export async function readReversals(ctx: FounderCallContext, originalTxId: string): Promise<FounderCallResult<OpsReversalList>> {
  return founderRecordCall(ctx, OPS_LEDGER_REVERSALS_LIST, { originalTxId, limit: LIST_LIMIT });
}

export type AskAnswer =
  | { readonly ok: true; readonly reversal: OpsLedgerReversal }
  | { readonly ok: false; readonly refusal: RefusalView; readonly firstReversal: FirstReversal | null };

/**
 * Ask svc-ops to reverse a transaction: it writes the intent row and nothing posts. A refusal as already reversed comes back
 * with the first reversal, read again from svc-ops' own list of requests for that transaction.
 */
export async function requestReversal(
  ctx: FounderCallContext,
  ask: { readonly originalTxId: string; readonly reason: string; readonly caseRef: string },
): Promise<AskAnswer> {
  const parked = reversalWritesParked(ctx);
  if (parked) return { ok: false, refusal: parked, firstReversal: null };
  const result = await treasuryWrite(OPS_LEDGER_REVERSALS_REQUEST, ask);
  if (result.kind === 'ok') {
    const reversal = result.data;
    if (reversal.originalTxId !== ask.originalTxId || reversal.state !== 'intent')
      return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true), firstReversal: null };
    return { ok: true, reversal };
  }
  const reply = failureRefusal('svc-ops', 'ops', result);
  const refusal = reply.ok ? explainRefusal(null, 502, true) : reply.refusal;
  let firstReversal: FirstReversal | null = null;
  if (refusal.code === 'ops.reversal_already_reversed') {
    const list = await readReversals(ctx, ask.originalTxId);
    if (list.kind === 'ok') firstReversal = firstReversalOf(list.data.reversals);
  }
  return { ok: false, refusal, firstReversal };
}

/** What svc-ops' row says after a run, in the desk's words. Only `posted` is a success. */
function reversalReply(reversal: OpsLedgerReversal, requestNo: string, originalTxId: string): ExecuteReply {
  if (reversal.requestNo !== requestNo || reversal.originalTxId !== originalTxId)
    return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  if (reversal.state === 'posted' && reversal.reversingTxId)
    return {
      ok: true,
      detail: `Reversal request ${reversal.requestNo} posted: transaction ${reversal.reversingTxId} reverses ${reversal.originalTxId}, approved by ${reversal.approverId ?? 'a second founder'}.`,
    };
  if (reversal.state === 'refused') {
    const view = explainRefusal(reversal.code ?? null, 409, false);
    return {
      ok: false,
      refusal: reversal.reversedBy ? { ...view, body: `${view.body} The ledger named ${reversal.reversedBy}.` } : view,
    };
  }
  // posting or pending_retry: the ledger has not answered yet. Never a failure, never a success.
  const view = explainRefusal(reversal.code ?? 'ledger.reply_lost', 0, true);
  return { ok: false, refusal: { ...view, changed: 'unknown' } };
}

/** Run an approved reversal on the treasury transport; svc-ops spends the approval once and asks the ledger. */
export function reversalExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'ops.ledger.reverse') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const parked = reversalWritesParked(ctx);
    if (parked) return { ok: false, refusal: parked };
    const result = await treasuryWrite(OPS_LEDGER_REVERSALS_EXECUTE, {
      requestNo: request.requestNo,
      approvalId: ids.approvalId,
      operationId: ids.operationId,
    });
    if (result.kind !== 'ok') return failureRefusal('svc-ops', 'ops', result);
    return reversalReply(result.data, request.requestNo, request.originalTxId);
  };
}
