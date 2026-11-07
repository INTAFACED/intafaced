import 'server-only';
import { createHash } from 'node:crypto';
import type { ActionApproval } from '@intafaced/contracts';
import { serviceCode } from './approvals';
import { parseApproval } from './approvals-parse';
import {
  parsePauseDesk,
  parsePauseRequest,
  type PauseDeskRead,
  type PauseOp,
  type PauseRequest,
  type PauseScope,
} from './copy-bots-pauses';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';

/**
 * The calls behind the kill switch's Copy and bots tab (CB-ops-03). Server only: each is a real call to svc-trade
 * (`copy.ops.pauses.*`) or svc-identity (`actionApproval`) through svc-edge with the signed-in founder's own token.
 * Nothing is cached or retried.
 */

export const COPY_BOTS_PAUSE_ACTION = 'trade.copy_bots_pause';
export const COPY_BOTS_RESUME_ACTION = 'trade.copy_bots_resume';
const TARGET_SERVICE = 'svc-trade';
const POLICY_VERSION = 'trade-copy-bots-pause-v1';

export const actionTypeOf = (op: PauseOp) => (op === 'pause' ? COPY_BOTS_PAUSE_ACTION : COPY_BOTS_RESUME_ACTION);
/** The state a change starts from, as svc-trade checks it when the approval is consumed. */
const expectedVersionOf = (op: PauseOp) => (op === 'pause' ? 'running' : 'paused');

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
 * What the approval binds: the request, the operation and the scope. svc-trade recomputes it when the second founder
 * confirms (`pauseApprovalPayload`) and refuses an approval bound to anything else, so this is byte for byte the same.
 */
export function pausePayloadHash(input: { requestId: string; op: PauseOp; scope: PauseScope }): string {
  const payload = {
    actionType: actionTypeOf(input.op),
    requestId: input.requestId,
    op: input.op,
    scopeKind: input.scope.kind,
    scopeValue: input.scope.value,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

/** Put svc-trade's own code (it ends the message in square brackets) on a refusal. */
function coded<T>(o: Outcome<T>): Outcome<T> {
  if (o.kind !== 'refused') return o;
  const code = serviceCode(o.code, o.message);
  return code === o.code ? o : { ...o, code, message: o.message.replace(/\s*\[[a-z_.]+\]\s*$/, '') };
}

const pauses = <T>(ctx: TradeCtx, proc: string, kind: 'query' | 'mutation', input: unknown, parse: (raw: unknown) => T | null) =>
  edgeCall(ctx, trpcSpec('trade', `copy.ops.pauses.${proc}`, kind, input, parse)).then(coded);

export function readPauseDesk(ctx: TradeCtx): Promise<Outcome<PauseDeskRead>> {
  return pauses(ctx, 'desk', 'query', {}, parsePauseDesk);
}

export function readPauseRequest(ctx: TradeCtx, requestId: string): Promise<Outcome<PauseRequest>> {
  return pauses(ctx, 'request', 'query', { requestId }, parsePauseRequest);
}

/** Founder A: file identity's approval, bound to this request, its operation and its scope. */
export function filePauseApproval(
  ctx: TradeCtx,
  input: { requestId: string; op: PauseOp; scope: PauseScope },
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
        expectedVersion: expectedVersionOf(input.op),
        payloadHash: pausePayloadHash(input),
        policyVersion: POLICY_VERSION,
      },
      parseApproval,
    ),
  ).then(coded);
}

/** Founder B: approve identity's request, checking it carries the hash this desk computes for the request. */
export function approvePauseApproval(
  ctx: TradeCtx,
  input: { approvalId: string; expectedPayloadHash: string },
): Promise<Outcome<ActionApproval>> {
  return edgeCall(ctx, trpcSpec('identity', 'actionApproval.approve', 'mutation', input, parseApproval)).then(coded);
}

export function proposePause(
  ctx: TradeCtx,
  input: { requestId: string; op: PauseOp; scope: PauseScope; approvalId: string },
): Promise<Outcome<PauseRequest>> {
  return pauses(ctx, 'propose', 'mutation', input, parsePauseRequest);
}

export function confirmPause(ctx: TradeCtx, input: { requestId: string; operationId: string }): Promise<Outcome<PauseRequest>> {
  return pauses(ctx, 'confirm', 'mutation', input, parsePauseRequest);
}
