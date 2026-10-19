/**
 * Live HTTP doors hitch TCA mill helpers (run / parent / markouts).
 * Beat-VWAP claim without owner benchmark plus retained market data refuses
 * (`tca_claim_unset`) — never invent a benchmark. Mill files and router.ts
 * are not recut. Never withdrawHold. Never post ledger.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CaptureLake } from '@intafaced/venue-adapter';
import { refuseUnsetTcaClaim, type OmsTcaClaimRefusal } from './oms-tca-refuse.js';
import { runTcaRun, type TcaObservation, type TcaEntitlements, type TcaRunResult } from './oms-tca.js';
import { runTcaForParent, type TcaParentResult } from './oms-tca-parent.js';
import { recordMarkoutsForParent, type OmsMarkoutsResult } from './oms-tca-markouts.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import { authorizeOmsWriteRequest, type OmsWriteS2s } from './oms-write-hmac.js';

export type OmsTcaDoorBody = {
  readonly parentClientOrderId?: string;
  readonly clientOrderId?: string;
  readonly executionGroupId?: string;
  readonly ownerBenchmark?: string | null;
  readonly retainedMarketData?: string | boolean | null;
  readonly arrivalAt?: string;
  readonly decisionAt?: string;
  readonly observations?: readonly TcaObservation[];
  readonly entitlements?: TcaEntitlements;
  readonly emsStore?: EmsOrderStore;
  readonly captureLake?: Pick<CaptureLake, 'records'>;
};

export type OmsTcaDoorDeps = {
  readonly edgeContext: (req: { headers: FastifyRequest['headers']; id: string }) => {
    principal?: { userId?: string; scopes?: readonly string[] } | null;
  };
  readonly internalSecret?: string | null;
  readonly s2s?: OmsWriteS2s;
  readonly emsStore?: EmsOrderStore;
  readonly captureLake?: Pick<CaptureLake, 'records'>;
};

function withStores(body: OmsTcaDoorBody, deps: OmsTcaDoorDeps): OmsTcaDoorBody {
  return {
    ...body,
    emsStore: body.emsStore ?? deps.emsStore,
    captureLake: body.captureLake ?? deps.captureLake,
  };
}

/** Pure door — tests call this. Claim refuse first, then mill hitch. */
export function handleOmsTcaClaimDoor(body: OmsTcaDoorBody): OmsTcaClaimRefusal | TcaRunResult {
  const claim = refuseUnsetTcaClaim({
    ownerBenchmark: body.ownerBenchmark,
    retainedMarketData: body.retainedMarketData,
  });
  if (!claim.ok) return claim;
  return runTcaRun({
    parentClientOrderId: body.parentClientOrderId,
    clientOrderId: body.clientOrderId,
    executionGroupId: body.executionGroupId,
    arrivalAt: body.arrivalAt,
    decisionAt: body.decisionAt,
    observations: body.observations,
    entitlements: body.entitlements,
    emsStore: body.emsStore,
    captureLake: body.captureLake,
  });
}

export function handleOmsTcaRunDoor(body: OmsTcaDoorBody): TcaRunResult {
  return runTcaRun({
    parentClientOrderId: body.parentClientOrderId,
    clientOrderId: body.clientOrderId,
    executionGroupId: body.executionGroupId,
    arrivalAt: body.arrivalAt,
    decisionAt: body.decisionAt,
    observations: body.observations,
    entitlements: body.entitlements,
    emsStore: body.emsStore,
    captureLake: body.captureLake,
  });
}

export function handleOmsTcaParentDoor(body: OmsTcaDoorBody): TcaParentResult {
  return runTcaForParent({
    parentClientOrderId: body.parentClientOrderId,
    emsStore: body.emsStore,
    captureLake: body.captureLake,
  });
}

export function handleOmsTcaMarkoutsDoor(body: OmsTcaDoorBody): OmsMarkoutsResult {
  return recordMarkoutsForParent({
    parentClientOrderId: body.parentClientOrderId,
    emsStore: body.emsStore,
    captureLake: body.captureLake,
  });
}

export function registerOmsTcaDoor(app: FastifyInstance, deps: OmsTcaDoorDeps): void {
  app.post('/execution/oms/tca', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsTcaDoorBody;
    return reply.send(handleOmsTcaRunDoor(withStores(body, deps)));
  });

  app.post('/execution/oms/tca-claim', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsTcaDoorBody;
    return reply.send(handleOmsTcaClaimDoor(withStores(body, deps)));
  });

  app.post('/execution/oms/tca-parent', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsTcaDoorBody;
    return reply.send(handleOmsTcaParentDoor(withStores(body, deps)));
  });

  app.post('/execution/oms/tca-markouts', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsTcaDoorBody;
    return reply.send(handleOmsTcaMarkoutsDoor(withStores(body, deps)));
  });
}
