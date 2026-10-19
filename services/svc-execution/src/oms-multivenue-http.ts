/**
 * Live HTTP doors hitch existing SOR plan + multi-venue refuses.
 * Best-ex claim without owner law refuses. Outage cannot invent a fill.
 * DEX names gas/MEV/reorg or refuses. Never invent a venue.
 * oms-plan.ts / venue-adapters / router.ts are not recut. Never withdrawHold.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { refuseLiveOmsMultivenue, type OmsMultivenueRefusal } from './oms-multivenue-refuse.js';
import { planOmsRoute, type OmsPlanInput, type OmsPlanResult } from './oms-plan.js';
import { authorizeOmsWriteRequest, type OmsWriteS2s } from './oms-write-hmac.js';

export type OmsMultivenueDoorBody = {
  readonly kind?: string | null;
  readonly bestEx?: boolean;
  readonly ownerBestExLaw?: string | null;
  readonly outage?: boolean;
  readonly inventedFill?: boolean;
  readonly gas?: string | boolean | null;
  readonly mev?: string | boolean | null;
  readonly reorg?: string | boolean | null;
  readonly venueId?: string | null;
  readonly wiredVenueIds?: readonly string[];
  readonly symbol?: string;
  /** Untrusted wire value. Only the exact strings buy and sell are a side. */
  readonly side?: unknown;
  readonly amount?: string;
  readonly venues?: OmsPlanInput['venues'];
};

export type OmsMultivenueDoorDeps = {
  readonly edgeContext: (req: { headers: FastifyRequest['headers']; id: string }) => {
    principal?: { userId?: string; scopes?: readonly string[] } | null;
  };
  readonly internalSecret?: string | null;
  readonly s2s?: OmsWriteS2s;
  readonly wiredVenueIds?: readonly string[];
};

function withWired(body: OmsMultivenueDoorBody, deps: OmsMultivenueDoorDeps): OmsMultivenueDoorBody {
  return {
    ...body,
    wiredVenueIds: body.wiredVenueIds ?? deps.wiredVenueIds,
  };
}

/** Pure door — tests call this. Claim refuse first, then existing plan hitch. */
export function handleOmsBestExClaimDoor(body: OmsMultivenueDoorBody): OmsMultivenueRefusal | { readonly ok: true } {
  const extra = refuseLiveOmsMultivenue({
    kind: body.kind ?? 'best-ex',
    bestEx: body.bestEx ?? true,
    ownerBestExLaw: body.ownerBestExLaw,
    outage: body.outage,
    inventedFill: body.inventedFill,
    gas: body.gas,
    mev: body.mev,
    reorg: body.reorg,
    venueId: body.venueId,
    wiredVenueIds: body.wiredVenueIds,
    venues: body.venues,
  });
  if (extra) return extra;
  return { ok: true };
}

export function handleOmsDexRouteDoor(body: OmsMultivenueDoorBody): OmsMultivenueRefusal | { readonly ok: true } {
  const extra = refuseLiveOmsMultivenue({
    kind: body.kind ?? 'external-dex',
    bestEx: body.bestEx,
    ownerBestExLaw: body.ownerBestExLaw,
    outage: body.outage,
    inventedFill: body.inventedFill,
    gas: body.gas,
    mev: body.mev,
    reorg: body.reorg,
    venueId: body.venueId,
    wiredVenueIds: body.wiredVenueIds,
    venues: body.venues,
  });
  if (extra) return extra;
  return { ok: true };
}

export type OmsPlanSideRefusal = {
  readonly ok: false;
  readonly reason: 'side_unset';
  readonly detail: string;
};

/** Exact buy or sell. Omitted, blank, and anything else are unnamed — never a default buy. */
function namedPlanSide(raw: unknown): 'buy' | 'sell' | null {
  return raw === 'buy' || raw === 'sell' ? raw : null;
}

export async function handleOmsPlanDoor(body: OmsMultivenueDoorBody): Promise<OmsMultivenueRefusal | OmsPlanSideRefusal | OmsPlanResult> {
  const extra = refuseLiveOmsMultivenue({
    kind: body.kind,
    bestEx: body.bestEx,
    ownerBestExLaw: body.ownerBestExLaw,
    outage: body.outage,
    inventedFill: body.inventedFill,
    gas: body.gas,
    mev: body.mev,
    reorg: body.reorg,
    venueId: body.venueId,
    wiredVenueIds: body.wiredVenueIds,
    venues: body.venues,
  });
  if (extra) return extra;
  const side = namedPlanSide(body.side);
  if (!side) {
    return {
      ok: false,
      reason: 'side_unset',
      detail: 'a plan that does not name a side refuses — rather than planning a buy',
    };
  }
  return planOmsRoute({
    symbol: body.symbol ?? '',
    side,
    amount: body.amount ?? '',
    venues: body.venues ?? [],
  });
}

export function registerOmsMultivenueDoor(app: FastifyInstance, deps: OmsMultivenueDoorDeps): void {
  app.post('/execution/oms/best-ex-claim', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsMultivenueDoorBody;
    return reply.send(handleOmsBestExClaimDoor(withWired(body, deps)));
  });

  app.post('/execution/oms/dex-route', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsMultivenueDoorBody;
    return reply.send(handleOmsDexRouteDoor(withWired(body, deps)));
  });

  app.post('/execution/oms/plan', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsMultivenueDoorBody;
    return reply.send(await handleOmsPlanDoor(withWired(body, deps)));
  });
}
