/**
 * Live HTTP doors hitch kill / drain / cancel-on-disconnect mill helpers.
 * Unset COD refuses (`cod_unset`). Session drop cancels in-scope opens via
 * `killInFlightExecution` when COD is set — never invents a flatten.
 * Matching halt is consumed (GET /markets venueHalted) — never POST /halt-all,
 * never recut matching (D-halt). oms-kill-live.ts is EXTRA. Mill files and
 * router.ts are not recut. Never withdrawHold.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { refuseUnsetCancelOnDisconnect, type OmsCodRefusal } from './oms-cod-refuse.js';
import { killInFlightExecution, type OmsKillResult } from './oms-kill.js';
import { drainInFlightAlgo, type OmsDrainResult } from './oms-drain.js';
import {
  matchingVenueHaltRefuse,
  resolveMatchingVenueHalt,
  type MatchingVenueHaltPort,
  type MatchingVenueHaltRefuse,
} from './oms-matching-venue-halt.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import { authorizeOmsWriteRequest, type OmsWriteS2s } from './oms-write-hmac.js';

export type OmsKillDoorBody = {
  readonly account?: string;
  readonly session?: string;
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  readonly cancelOnDisconnect?: string | boolean | null;
  readonly cod?: string | boolean | null;
  readonly emsStore?: EmsOrderStore;
};

export type OmsKillDoorDeps = {
  readonly edgeContext: (req: { headers: FastifyRequest['headers']; id: string }) => {
    principal?: { userId?: string; scopes?: readonly string[] } | null;
  };
  readonly emsStore?: EmsOrderStore;
  readonly matchingVenueHalt?: MatchingVenueHaltPort;
  readonly internalSecret?: string | null;
  readonly s2s?: OmsWriteS2s;
};

export type OmsVenueHaltDoorOk = {
  readonly ok: true;
  readonly venueHalted: false;
};

/** Pure door — tests call this. Account XOR session. Never flatten inventively. */
export function handleOmsKillDoor(body: OmsKillDoorBody): Promise<OmsKillResult> {
  return killInFlightExecution({
    account: body.account,
    session: body.session,
    emsStore: body.emsStore,
  });
}

/** Pure door — parent XOR group. Never invent a canceled child. */
export function handleOmsDrainDoor(body: OmsKillDoorBody): Promise<OmsDrainResult> {
  return drainInFlightAlgo({
    parentClientOrderId: body.parentClientOrderId,
    executionGroupId: body.executionGroupId,
    emsStore: body.emsStore,
  });
}

/**
 * Dead-man / COD. Unset refuses. Set + session hitches live kill mill.
 * Never invents an account flatten.
 */
export async function handleOmsCodDoor(body: OmsKillDoorBody): Promise<OmsCodRefusal | OmsKillResult> {
  const policy = refuseUnsetCancelOnDisconnect(body.cancelOnDisconnect ?? body.cod);
  if (!policy.ok) return policy;
  const session = body.session?.trim() ?? '';
  if (!session) {
    return {
      ok: false,
      reason: 'missing_scope',
      detail: 'session is required for cancel-on-disconnect — refusing to invent a flatten',
    };
  }
  return killInFlightExecution({
    session,
    emsStore: body.emsStore,
  });
}

/** Consume matching halt-all. Missing source refuses — never invent live or a halt. */
export async function handleOmsVenueHaltDoor(port: MatchingVenueHaltPort): Promise<MatchingVenueHaltRefuse | OmsVenueHaltDoorOk> {
  const source = await resolveMatchingVenueHalt(port);
  const refused = matchingVenueHaltRefuse(source);
  if (refused) return refused;
  return { ok: true, venueHalted: false };
}

export function registerOmsKillDoor(app: FastifyInstance, deps: OmsKillDoorDeps): void {
  app.post('/execution/oms/kill', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsKillDoorBody;
    return reply.send(await handleOmsKillDoor({ ...body, emsStore: body.emsStore ?? deps.emsStore }));
  });

  app.post('/execution/oms/drain', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsKillDoorBody;
    return reply.send(await handleOmsDrainDoor({ ...body, emsStore: body.emsStore ?? deps.emsStore }));
  });

  app.post('/execution/oms/cod', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsKillDoorBody;
    return reply.send(await handleOmsCodDoor({ ...body, emsStore: body.emsStore ?? deps.emsStore }));
  });

  app.post('/execution/oms/venue-halt', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    return reply.send(await handleOmsVenueHaltDoor(deps.matchingVenueHalt));
  });
}
