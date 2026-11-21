import 'server-only';
import { createHash } from 'node:crypto';
import type { ActionApproval } from '@intafaced/contracts';
import { serviceCode } from './approvals';
import { parseApproval } from './approvals-parse';
import { parseHalt, parseHaltDesk, parseHaltRequest, type Halt, type HaltDeskRead, type HaltOp, type HaltRequest } from './quant-halts';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';

/**
 * The calls behind the live strategy desk (/more-ops/quant, J-algo-dev-11). Server only: each is a real call to
 * svc-trade (`admin.quantLive.*`) or svc-identity (`actionApproval`) through svc-edge with the signed-in founder's own
 * token. Nothing is cached or retried.
 */

const TARGET_SERVICE = 'svc-trade';
const POLICY_VERSION = 'trade-quant-live-halt-v1';

export const actionTypeOf = (op: HaltOp) =>
  op === 'halt_all' ? 'trade.quant_live_halt_all' : op === 'restore' ? 'trade.quant_live_restore' : 'trade.quant_live_restore_all';
/** The state a change starts from, as svc-trade checks it when the approval is consumed (`expectedVersionOf`). */
const expectedVersionOf = (op: HaltOp, haltId: string | null) =>
  op === 'halt_all' ? 'running' : op === 'restore' ? `halt:${haltId}` : 'halted';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error('payload is not JSON');
}

/**
 * What the approval binds: the request, its operation, the halt it lifts and its reason. svc-trade recomputes it when
 * the second founder confirms (`haltApprovalPayload`) and refuses an approval bound to anything else.
 */
export function haltPayloadHash(input: { requestId: string; op: HaltOp; haltId: string | null; reason: string }): string {
  const payload = {
    actionType: actionTypeOf(input.op),
    requestId: input.requestId,
    op: input.op,
    haltId: input.haltId,
    reason: input.reason,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

/** Put svc-trade's own code (it ends the message in square brackets) on a refusal. */
function coded<T>(o: Outcome<T>): Outcome<T> {
  if (o.kind !== 'refused') return o;
  const code = serviceCode(o.code, o.message);
  return code === o.code ? o : { ...o, code, message: o.message.replace(/\s*\[[a-z_.]+\]\s*$/, '') };
}

const desk = <T>(ctx: TradeCtx, proc: string, kind: 'query' | 'mutation', input: unknown, parse: (raw: unknown) => T | null) =>
  edgeCall(ctx, trpcSpec('trade', `admin.quantLive.${proc}`, kind, input, parse)).then(coded);

export function readHaltDesk(ctx: TradeCtx): Promise<Outcome<HaltDeskRead>> {
  return desk(ctx, 'desk', 'query', {}, parseHaltDesk);
}

export function readHaltRequest(ctx: TradeCtx, requestId: string): Promise<Outcome<HaltRequest>> {
  return desk(ctx, 'request', 'query', { requestId }, parseHaltRequest);
}

/** One operator halts one strategy, with a reason. */
export function haltOne(
  ctx: TradeCtx,
  input: { requestId: string; userId: string; strategyId: string; reason: string },
): Promise<Outcome<Halt>> {
  return desk(ctx, 'halt', 'mutation', input, parseHalt);
}

/** Founder A: file identity's approval, bound to this request, its operation, the halt it lifts and its reason. */
export function fileHaltApproval(
  ctx: TradeCtx,
  input: { requestId: string; op: HaltOp; haltId: string | null; reason: string },
): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: actionTypeOf(input.op),
        targetService: TARGET_SERVICE,
        targetId: input.requestId,
        expectedVersion: expectedVersionOf(input.op, input.haltId),
        payloadHash: haltPayloadHash(input),
        policyVersion: POLICY_VERSION,
      },
      parseApproval,
    ),
  ).then(coded);
}

/** Founder B: approve identity's request, checking it carries the hash this desk computes for the request. */
export function approveHaltApproval(
  ctx: TradeCtx,
  input: { approvalId: string; expectedPayloadHash: string },
): Promise<Outcome<ActionApproval>> {
  return edgeCall(ctx, trpcSpec('identity', 'actionApproval.approve', 'mutation', input, parseApproval)).then(coded);
}

export function proposeHalt(
  ctx: TradeCtx,
  input: { requestId: string; op: HaltOp; haltId: string | null; reason: string; approvalId: string },
): Promise<Outcome<HaltRequest>> {
  return desk(ctx, 'propose', 'mutation', input, parseHaltRequest);
}

export function confirmHalt(ctx: TradeCtx, input: { requestId: string; operationId: string }): Promise<Outcome<HaltRequest>> {
  return desk(ctx, 'confirm', 'mutation', input, parseHaltRequest);
}
