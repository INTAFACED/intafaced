/**
 * The user-venue door's REST routes (B1; src/venue/user-venue-door.ts), for the signed-in customer:
 *
 *   GET  /api/v1/venue/status                          `{ enabled: false }` when the door is off; else the venue, TEST label, chain id
 *   GET  /api/v1/venue/markets
 *   GET  /api/v1/venue/balances?owner=0x…              (and orders/open, positions, agents, builder-fee-approval)
 *   GET  /api/v1/venue/orders/by-client-id?owner=&clientOrderId=
 *   GET  /api/v1/venue/fills?owner=&since=<ISO>
 *   GET  /api/v1/venue/withdrawals/:nonce?owner=
 *   GET  /api/v1/venue/leverage?owner=&symbol=
 *   POST /api/v1/venue/preview   { owner, intent }
 *   POST /api/v1/venue/prepare   { owner, signer, intent, actionKey?, stepUpApprovalId? }
 *   POST /api/v1/venue/submit    { actionKey, signature }
 *
 * Reads need trade:read, writes trade:write, and every route but `status` the trade jurisdiction (as the grid's
 * routes do). Every Amount travels as a decimal string (`encodeVenueWire`). A venue refusal answers 422 with
 * `intafacedCode: trade.venue.<code>` and the venue's `refusal` (503 for `venue_down`); a step-up refusal 403.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { StepUpCheckError } from '@intafaced/contracts';
import {
  VenueRefusalError,
  VenueWireError,
  decodeVenueWire,
  encodeVenueWire,
  type VenueIntent,
  type VenueSignature,
  type VenueSigner,
} from '@intafaced/venue-contracts';
import { toCcxtError } from '../ccxt-errors.js';
import { privateRead, privateWrite } from '../route-inventory.js';
import { UserVenueDoor, UserVenueDoorError } from './user-venue-door.js';

export interface UserVenueRestDeps {
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null;
  requireTradeJurisdiction: (req: FastifyRequest, reply: FastifyReply, principal: Principal) => boolean;
}

type Query = { owner?: string; subAccount?: string; clientOrderId?: string; since?: string; symbol?: string };

export function venueRefusalReply(reply: FastifyReply, err: unknown) {
  if (err instanceof VenueRefusalError) {
    const down = err.refusal.code === 'venue_down';
    return reply.code(down ? 503 : 422).send({
      code: down ? 'ExchangeNotAvailable' : 'InvalidOrder',
      message: err.refusal.detail,
      intafacedCode: `trade.venue.${err.refusal.code}`,
      refusal: err.refusal,
    });
  }
  if (err instanceof UserVenueDoorError) {
    return reply
      .code(err.status)
      .send({ code: err.status === 404 ? 'NotFound' : 'BadRequest', message: err.message, intafacedCode: err.code });
  }
  if (err instanceof StepUpCheckError) {
    const unavailable = err.code === 'identity.step_up_unavailable';
    return reply
      .code(unavailable ? 503 : 403)
      .send({ code: unavailable ? 'ExchangeNotAvailable' : 'PermissionDenied', message: err.message, intafacedCode: err.code });
  }
  if (err instanceof VenueWireError)
    return reply.code(400).send({ code: 'BadRequest', message: err.message, intafacedCode: 'trade.venue_request_invalid' });
  const shared = toCcxtError(err);
  if (shared) return reply.code(shared.status).send(shared.body);
  throw err;
}

export function attachUserVenueRoutes(app: FastifyInstance, door: UserVenueDoor | null, deps: UserVenueRestDeps): void {
  function admit(req: FastifyRequest, reply: FastifyReply, scope: Scope): Principal | null {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return null;
    try {
      requireScope(principal, scope);
    } catch (error) {
      void venueRefusalReply(reply, error);
      return null;
    }
    return deps.requireTradeJurisdiction(req, reply, principal) ? principal : null;
  }

  async function answer(reply: FastifyReply, run: (d: UserVenueDoor) => Promise<unknown>) {
    try {
      if (!door)
        throw new UserVenueDoorError(
          'the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)',
          'trade.user_venue_off',
          404,
        );
      return reply.code(200).send(encodeVenueWire(await run(door)));
    } catch (error) {
      return venueRefusalReply(reply, error);
    }
  }

  function body<T>(req: FastifyRequest): T {
    const raw = req.body;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new VenueWireError('the body must be a JSON object');
    return decodeVenueWire<T>(raw);
  }

  app.get('/api/v1/venue/status', privateRead, async (req, reply) => {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return;
    try {
      requireScope(principal, 'trade:read');
    } catch (error) {
      return venueRefusalReply(reply, error);
    }
    if (!door) return reply.code(200).send({ enabled: false });
    return reply.code(200).send(await door.status());
  });

  app.get('/api/v1/venue/markets', privateRead, async (req, reply) => {
    if (!admit(req, reply, 'trade:read')) return;
    return answer(reply, async (d) => (await d.venue()).markets(null));
  });

  type Account = Awaited<ReturnType<UserVenueDoor['account']>>;
  // The venue's account reads, by path. Registered in one literal loop so the published route list can see every one
  // (apps/customer developers-reference.test.ts reads `for (const path of [...])`).
  const accountReads: Record<string, (d: UserVenueDoor, q: Query, a: Account) => Promise<unknown>> = {
    '/api/v1/venue/balances': async (d, _q, a) => (await d.venue()).balances(a),
    '/api/v1/venue/orders/open': async (d, _q, a) => (await d.venue()).openOrders(a),
    '/api/v1/venue/positions': async (d, _q, a) => (await d.venue()).positions(a),
    '/api/v1/venue/agents': async (d, _q, a) => (await d.venue()).agents(a),
    '/api/v1/venue/orders/by-client-id': async (d, q, a) => {
      if (!q.clientOrderId) throw new VenueWireError('clientOrderId is required');
      return (await d.venue()).orderByClientId(a, q.clientOrderId);
    },
    '/api/v1/venue/fills': async (d, q, a) => {
      const since = new Date(q.since ?? '');
      if (Number.isNaN(since.getTime())) throw new VenueWireError('since is required (an ISO time)');
      return (await d.venue()).fills(a, since);
    },
    '/api/v1/venue/leverage': async (d, q, a) => {
      if (!q.symbol) throw new VenueWireError('symbol is required');
      return (await d.venue()).leverage(a, q.symbol);
    },
    '/api/v1/venue/builder-fee-approval': async (d, _q, a) => {
      const status = await d.status();
      const builder = 'builder' in status ? status.builder : null;
      if (!builder)
        throw new VenueRefusalError({
          venueId: a.venueId,
          code: 'builder_fee_not_published',
          detail: 'our builder is not published (owner value blank)',
        });
      return (await d.venue()).builderFeeApproval(a, builder.address);
    },
  };
  for (const path of [
    '/api/v1/venue/balances',
    '/api/v1/venue/orders/open',
    '/api/v1/venue/positions',
    '/api/v1/venue/agents',
    '/api/v1/venue/orders/by-client-id',
    '/api/v1/venue/fills',
    '/api/v1/venue/leverage',
    '/api/v1/venue/builder-fee-approval',
  ]) {
    const read = accountReads[path]!;
    app.get<{ Querystring: Query }>(path, privateRead, async (req, reply) => {
      if (!admit(req, reply, 'trade:read')) return;
      return answer(reply, async (d) => read(d, req.query, await d.account(req.query.owner ?? '', req.query.subAccount ?? null)));
    });
  }

  app.get<{ Params: { nonce: string }; Querystring: Query }>('/api/v1/venue/withdrawals/:nonce', privateRead, async (req, reply) => {
    if (!admit(req, reply, 'trade:read')) return;
    return answer(reply, async (d) =>
      (await d.venue()).withdrawal(await d.account(req.query.owner ?? '', req.query.subAccount ?? null), req.params.nonce),
    );
  });

  app.post('/api/v1/venue/preview', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (d) => {
      const b = body<{ owner?: string; intent?: VenueIntent }>(req);
      return d.preview(principal, b.owner ?? '', b.intent as VenueIntent);
    });
  });

  app.post('/api/v1/venue/prepare', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (d) => {
      const b = body<{
        owner?: string;
        subAccount?: string | null;
        signer?: VenueSigner;
        intent?: VenueIntent;
        actionKey?: string | null;
        stepUpApprovalId?: string | null;
      }>(req);
      return d.prepare(principal, {
        owner: b.owner ?? '',
        subAccount: b.subAccount ?? null,
        signer: b.signer as VenueSigner,
        intent: b.intent as VenueIntent,
        actionKey: b.actionKey ?? null,
        stepUpApprovalId: b.stepUpApprovalId ?? null,
      });
    });
  });

  app.post('/api/v1/venue/submit', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (d) => {
      const b = body<{ actionKey?: string; signature?: VenueSignature }>(req);
      return d.submit(principal, b.actionKey ?? '', b.signature as VenueSignature);
    });
  });
}
