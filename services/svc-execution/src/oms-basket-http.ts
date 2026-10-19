/**
 * Live HTTP + tRPC door for startBasketParent, then hitch children onto matching POST.
 * Generic live slice (twap|vwap|pov) does not cover basket — no sliceBasket dual-implement.
 * tRPC startBasket calls handleStartBasketDoor. tRPC killBasket calls
 * handleKillBasketDoor. Writes require HMAC as svc-execution. Matching mill is not recut.
 * Ledger qty strings. Partial-failure refuse_all only: a later refused leg kills
 * children already accepted so they do not keep working. The posted refusal is
 * returned only when every accepted child came back stopped or already_stopped,
 * and that refusal names the acks of children already accepted.
 * An unconfirmed kill is not a successful start: the start door returns ok
 * false and names the child that was not killed. That case is kill_unconfirmed,
 * not matching_rejected. Kill-basket's own killed-false result stays put.
 * Paper never ledgers. Kill-basket unknown matching cancel is killed false.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { startBasketParent, type OmsBasketStartResult } from './oms-basket-start.js';
import {
  killBasketMatchingChildren,
  postBasketChildrenToMatching,
  type OmsBasketMatchingChildInput,
  type OmsBasketMatchingKillChild,
  type OmsBasketMatchingKillOutcome,
  type OmsBasketMatchingKillResult,
  type OmsBasketMatchingResult,
} from './oms-basket-matching.js';
import { resolveMatchingVenueHalt, type MatchingVenueHaltPort } from './oms-matching-venue-halt.js';
import { refuseLiveOmsPaper, type OmsPaperUnsupportedRefuse } from './oms-paper-refuse.js';
import type { AlgoJobsGate } from './oms-start.js';
import { authorizeOmsWriteRequest, type OmsWriteS2s } from './oms-write-hmac.js';

export type StartBasketDoorBody = {
  readonly parentClientOrderId?: string;
  readonly kind?: string;
  readonly approved?: boolean;
  readonly status?: string;
  readonly paper?: boolean;
  readonly legs?: readonly OmsBasketMatchingChildInput[];
  readonly partialFailurePolicy?: string | null;
  readonly credit?: string | null;
  readonly remaining?: string | null;
  readonly operatorId?: string;
  readonly accountId?: string | null;
  readonly type?: string | null;
  readonly tif?: string | null;
  readonly lifecycleProof?: unknown;
};

export type KillBasketDoorBody = {
  readonly children?: readonly OmsBasketMatchingKillChild[];
};

export type StartBasketDoorDeps = {
  readonly jobs: AlgoJobsGate;
  readonly matchingVenueHalt: MatchingVenueHaltPort;
  readonly matchingUrl?: string | null;
  readonly fetch?: typeof fetch;
  readonly internalSecret?: string | null;
  readonly s2s?: OmsWriteS2s;
  readonly edgeContext: (req: { headers: FastifyRequest['headers']; id: string }) => {
    principal?: { userId?: string; scopes?: readonly string[] } | null;
  };
};

/** Start door only. An unconfirmed kill names the child and is not a start. */
export type StartBasketKillUnconfirmed = {
  readonly ok: false;
  readonly reason: 'kill_unconfirmed';
  readonly detail: string;
  readonly children: readonly OmsBasketMatchingKillOutcome[];
};

export type StartBasketDoorResult =
  OmsBasketStartResult | OmsBasketMatchingResult | OmsBasketMatchingKillResult | StartBasketKillUnconfirmed | OmsPaperUnsupportedRefuse;

/** Pure door — tests call this. Signed principal is the operator; body operatorId is ignored. */
export async function handleStartBasketDoor(
  body: StartBasketDoorBody,
  operatorId: string | undefined,
  deps: Pick<StartBasketDoorDeps, 'jobs' | 'matchingVenueHalt' | 'matchingUrl' | 'fetch'>,
): Promise<StartBasketDoorResult> {
  const paper = refuseLiveOmsPaper({ kind: body.kind, paper: body.paper === true });
  if (paper) return paper;
  const started = startBasketParent({
    parentClientOrderId: body.parentClientOrderId,
    kind: body.kind,
    approved: body.approved,
    status: body.status,
    legs: body.legs,
    partialFailurePolicy: body.partialFailurePolicy,
    credit: body.credit,
    remaining: body.remaining,
    operatorId,
    jobs: deps.jobs,
    matchingVenueHalt: await resolveMatchingVenueHalt(deps.matchingVenueHalt),
  });
  if (!started.ok) return started;
  const accepted: OmsBasketMatchingKillChild[] = [];
  const posted = await postBasketChildrenToMatching({
    parent: started,
    legs: body.legs,
    accountId: body.accountId,
    type: body.type,
    tif: body.tif,
    lifecycleProof: body.lifecycleProof,
    matchingUrl: deps.matchingUrl,
    fetch: deps.fetch,
    onChildAccepted: (child) => {
      accepted.push({ marketId: child.marketId, orderId: child.orderId });
    },
  });
  if (!posted.ok && accepted.length > 0) {
    const killed =
      posted.kill ??
      (await killBasketMatchingChildren({
        children: accepted,
        matchingUrl: deps.matchingUrl,
        fetch: deps.fetch,
      }));
    const everyAcceptedChildStopped =
      killed.ok &&
      killed.children.length === accepted.length &&
      killed.children.every((child) => child.outcome === 'stopped' || child.outcome === 'already_stopped');
    if (everyAcceptedChildStopped) {
      return {
        ok: false,
        reason: posted.reason,
        detail: posted.detail,
        ...(posted.children ? { children: posted.children } : {}),
      };
    }
    if (!killed.ok) return killed;
    const notKilled = killed.children.filter((child) => child.outcome === 'unknown');
    const named = notKilled.map((child) => `${child.marketId} ${child.orderId}`).join(', ');
    return {
      ok: false,
      reason: 'kill_unconfirmed',
      detail: named ? `unconfirmed kill is not a successful start; not killed: ${named}` : 'unconfirmed kill is not a successful start',
      children: notKilled,
    };
  }
  return posted;
}

/** Pure door — unknown matching cancel is killed false. */
export async function handleKillBasketDoor(
  body: KillBasketDoorBody,
  deps: Pick<StartBasketDoorDeps, 'matchingUrl' | 'fetch'>,
): Promise<OmsBasketMatchingKillResult> {
  return killBasketMatchingChildren({
    children: body.children,
    matchingUrl: deps.matchingUrl,
    fetch: deps.fetch,
  });
}

export function registerStartBasketDoor(app: FastifyInstance, deps: StartBasketDoorDeps): void {
  app.post('/execution/oms/start-basket', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const ctx = deps.edgeContext(req);
    const body = (req.body ?? {}) as StartBasketDoorBody;
    return handleStartBasketDoor(body, ctx.principal?.userId, deps);
  });

  app.post('/execution/oms/kill-basket', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as KillBasketDoorBody;
    return handleKillBasketDoor(body, deps);
  });
}
