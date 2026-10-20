/**
 * Live HTTP + tRPC door for killLiveAlgoParent.
 * Matching never-saw (404) / ack without sequence is killed false.
 * tRPC killParent calls handleKillParentDoor. Matching mill is not recut.
 * Paper never ledgers. Cancel is a request until matching sequence.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { VenueKind } from '@intafaced/venue-adapter';
import { killLiveAlgoParent, type OmsKillParentResult } from './oms-kill-parent.js';
import type { OmsCancelFn } from './oms-cancel.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import type { AlgoPauseStore } from './oms-pause.js';
import { refuseLiveOmsPaper, type OmsPaperUnsupportedRefuse } from './oms-paper-refuse.js';
import type { ApprovedAlgoParentStore } from './oms-start.js';
import type { OmsKillParentMatchingChild, OmsMatchingS2s } from './oms-kill-parent-matching.js';
import { authorizeOmsWriteRequest, type OmsWriteS2s } from './oms-write-hmac.js';

export type KillParentDoorBody = {
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  readonly paper?: boolean;
  readonly kind?: string;
  readonly children?: readonly OmsKillParentMatchingChild[];
};

export type KillParentDoorDeps = {
  readonly parentStore?: ApprovedAlgoParentStore;
  readonly pauseStore?: AlgoPauseStore;
  readonly emsStore?: EmsOrderStore;
  readonly cancelByVenue?: Readonly<Record<string, OmsCancelFn>>;
  readonly kindsByVenue?: Readonly<Record<string, VenueKind>>;
  readonly matchingUrl?: string | null;
  readonly fetch?: typeof fetch;
  readonly internalSecret?: string | null;
  readonly s2s?: OmsWriteS2s;
  /** svc-execution's own key for the calls to matching; the `s2s` above is for the calls coming in. */
  readonly matchingS2s?: OmsMatchingS2s;
  readonly edgeContext: (req: { headers: FastifyRequest['headers']; id: string }) => {
    principal?: { userId?: string; scopes?: readonly string[] } | null;
  };
};

export type KillParentDoorResult = OmsKillParentResult | OmsPaperUnsupportedRefuse;

/** Pure door — tests call this. Signed principal is the operator; body operatorId is ignored. */
export async function handleKillParentDoor(
  body: KillParentDoorBody,
  operatorId: string | undefined,
  deps: Omit<KillParentDoorDeps, 'edgeContext'>,
): Promise<KillParentDoorResult> {
  const paper = refuseLiveOmsPaper({ kind: body.kind, paper: body.paper === true });
  if (paper) return paper;
  return killLiveAlgoParent({
    parentClientOrderId: body.parentClientOrderId,
    executionGroupId: body.executionGroupId,
    operatorId,
    parentStore: deps.parentStore,
    pauseStore: deps.pauseStore,
    emsStore: deps.emsStore,
    cancelByVenue: deps.cancelByVenue,
    kindsByVenue: deps.kindsByVenue,
    matchingUrl: deps.matchingUrl,
    matchingChildren: body.children,
    fetch: deps.fetch,
    matchingS2s: deps.matchingS2s,
  });
}

export function registerKillParentDoor(app: FastifyInstance, deps: KillParentDoorDeps): void {
  app.post('/execution/oms/kill-parent', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const ctx = deps.edgeContext(req);
    const body = (req.body ?? {}) as KillParentDoorBody;
    return reply.send(await handleKillParentDoor(body, ctx.principal?.userId, deps));
  });
}
