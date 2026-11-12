/**
 * The REST routes of a live strategy run (J-algo-dev-07; live-runs.ts), for the signed-in person:
 *
 *   GET  /api/v1/quant/live-runs                         the person's runs, newest first
 *   POST /api/v1/quant/live-runs                         { runId, strategyId, strategyVersion, owner, subAccount, cap,
 *                                                         restartAttempts, statePolicy, liveControl }: start one
 *   GET  /api/v1/quant/live-runs/:id                     the run, its orders, the sub-account as the venue reports it, its log
 *   POST /api/v1/quant/live-runs/:id/submit              { actionKey, signature }: the wallet's agent permission
 *   POST /api/v1/quant/live-runs/:id/stop                { seq }: cancel the open orders, keep the position
 *   POST /api/v1/quant/live-runs/:id/liquidate           { seq }: stop, then one reduce-only close
 *   POST /api/v1/quant/live-runs/:id/orders              { seq, side, type, symbol, size, price? }: a manual order
 *   POST /api/v1/quant/live-runs/:id/test/kill-process   TEST venue only: the run's process dies
 *
 * Reads need trade:read, writes trade:write, every route the trade jurisdiction and the person's own session or key
 * (an agent account's key is refused). Amounts travel as decimal strings. A refusal answers `intafacedCode`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { EDGE_PRINCIPAL_HEADER, EDGE_SIGNATURE_HEADER } from '@intafaced/contracts';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { VenueWireError, decodeVenueWire, encodeVenueWire, type VenueSignature } from '@intafaced/venue-contracts';
import { privateRead, privateWrite } from '../../route-inventory.js';
import { agentAccountReply } from '../../venue/agent-account-rest.js';
import { UserVenueDoorError } from '../../venue/user-venue-door.js';
import { refusedAgentKey, venueRefusalReply, type UserVenueRestDeps } from '../../venue/user-venue-rest.js';
import { LiveRunError, type LiveRuns } from './live-runs.js';

export const LIVE_RUNS_PATH = '/api/v1/quant/live-runs';

export function liveRunReply(reply: FastifyReply, err: unknown) {
  if (err instanceof LiveRunError) {
    return reply
      .code(err.status)
      .send({ code: err.status === 404 ? 'NotFound' : 'InvalidOrder', message: err.message, intafacedCode: err.code, ...err.detail });
  }
  return agentAccountReply(reply, err);
}

/** The edge-signed principal of this request, byte for byte, for svc-quant to answer the person's own strategy. */
function forwardedOf(req: FastifyRequest): Record<string, string> {
  const h = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const raw = h(EDGE_PRINCIPAL_HEADER);
  const sig = h(EDGE_SIGNATURE_HEADER);
  if (!raw || !sig) return {};
  return { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: sig, 'x-intafaced-region': h('x-intafaced-region') ?? 'XX' };
}

export function attachLiveRunRoutes(app: FastifyInstance, runs: LiveRuns | null, deps: UserVenueRestDeps): void {
  async function admit(req: FastifyRequest, reply: FastifyReply, scope: Scope): Promise<Principal | null> {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return null;
    if (await refusedAgentKey(reply, principal, deps)) return null;
    try {
      requireScope(principal, scope);
    } catch (error) {
      void venueRefusalReply(reply, error);
      return null;
    }
    return deps.requireTradeJurisdiction(req, reply, principal) ? principal : null;
  }

  async function answer(reply: FastifyReply, run: (r: LiveRuns) => Promise<unknown>) {
    try {
      if (!runs)
        throw new UserVenueDoorError(
          'the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)',
          'trade.user_venue_off',
          404,
        );
      return reply.code(200).send(encodeVenueWire(await run(runs)));
    } catch (error) {
      return liveRunReply(reply, error);
    }
  }

  function body(req: FastifyRequest): Record<string, unknown> {
    const raw = req.body ?? {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new VenueWireError('the body must be a JSON object');
    return raw as Record<string, unknown>;
  }

  type Run = { Params: { id: string } };

  app.get(LIVE_RUNS_PATH, privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (r) => ({ runs: await r.list(principal) }));
  });

  app.post(LIVE_RUNS_PATH, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (r) => r.start(principal, forwardedOf(req), body(req)));
  });

  app.get<Run>(`${LIVE_RUNS_PATH}/:id`, privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (r) => r.get(principal, req.params.id));
  });

  app.post<Run>(`${LIVE_RUNS_PATH}/:id/submit`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (r) => {
      const b = decodeVenueWire<{ actionKey?: string; signature?: VenueSignature }>(body(req));
      return r.submit(principal, req.params.id, b.actionKey, b.signature as VenueSignature);
    });
  });

  app.post<Run>(`${LIVE_RUNS_PATH}/:id/stop`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (r) => r.stop(principal, req.params.id, body(req)));
  });

  app.post<Run>(`${LIVE_RUNS_PATH}/:id/liquidate`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (r) => r.liquidate(principal, req.params.id, body(req)));
  });

  app.post<Run>(`${LIVE_RUNS_PATH}/:id/orders`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (r) => r.manualOrder(principal, req.params.id, body(req)));
  });

  app.post<Run>(`${LIVE_RUNS_PATH}/:id/test/kill-process`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (r) => r.killProcess(principal, req.params.id));
  });
}
