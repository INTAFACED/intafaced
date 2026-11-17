/**
 * The REST routes of conditional spot orders on the person's own venue account (J-cex-spot-08; src/venue/spot-conditionals.ts):
 *
 *   GET    /api/v1/venue/spot-orders?owner=          every stop-limit, stop-market, OCO, bracket and linked close, each leg
 *                                                    with where it rests and what the venue reads for it now
 *   POST   /api/v1/venue/spot-orders                { owner, symbol, kind, side, quantity, triggerPrice?, limitPrice?,
 *                                                    takeProfitPrice?, entryPrice?, entryTif?, closePrice?, clientOrderId }:
 *                                                    a stop the venue holds answers its unsigned trigger order (200); the
 *                                                    rest is made on our engine (201), with a bracket's entry unsigned
 *   POST   /api/v1/venue/spot-orders/review         the same body: each leg's fee, maker or taker, from the venue's schedule
 *   PATCH  /api/v1/venue/spot-orders/:id            { triggerPrice, limitPrice? }: a live stop's new trigger
 *   DELETE /api/v1/venue/spot-orders/:id            cancel: what rests on the venue for it is cancelled there
 *   GET    /api/v1/venue/spot-agent?owner=          the spot-order key and whether the venue lists it approved
 *   POST   /api/v1/venue/spot-agent/prepare         { owner }: the unsigned approval of that key, for the wallet
 *
 * Reads need trade:read, writes trade:write, and every route the trade jurisdiction. Amounts travel as decimal strings.
 * A refusal answers its code as `error` and `intafacedCode`, with its words as `message`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { encodeVenueWire } from '@intafaced/venue-contracts';
import { privateRead, privateWrite } from '../route-inventory.js';
import { SpotConditionalError, type VenueSpotConditionals } from './spot-conditionals.js';
import { UserVenueDoorError } from './user-venue-door.js';
import { refusedAgentKey, venueRefusalReply, type UserVenueRestDeps } from './user-venue-rest.js';

export const SPOT_ORDERS_PATH = '/api/v1/venue/spot-orders';

export function attachSpotConditionalRoutes(
  app: FastifyInstance,
  spot: VenueSpotConditionals | null,
  deps: UserVenueRestDeps & { readonly regionOf?: (req: FastifyRequest) => string },
): void {
  async function admit(req: FastifyRequest, reply: FastifyReply, scope: Scope): Promise<Principal | null> {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return null;
    // A key connected to an agent account trades only through the assistant's own route (J-agents-21 #9).
    if (await refusedAgentKey(reply, principal, deps)) return null;
    try {
      requireScope(principal, scope);
    } catch (error) {
      void venueRefusalReply(reply, error);
      return null;
    }
    return deps.requireTradeJurisdiction(req, reply, principal) ? principal : null;
  }

  async function answer(
    reply: FastifyReply,
    run: (s: VenueSpotConditionals) => Promise<unknown>,
    statusOf: (v: unknown) => number = () => 200,
  ) {
    try {
      if (!spot) {
        throw new UserVenueDoorError(
          'the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)',
          'trade.user_venue_off',
          404,
        );
      }
      const value = await run(spot);
      return reply.code(statusOf(value)).send(encodeVenueWire(value));
    } catch (error) {
      if (error instanceof SpotConditionalError) {
        return reply.code(error.status).send({ code: 'BadRequest', error: error.code, intafacedCode: error.code, message: error.message });
      }
      return venueRefusalReply(reply, error);
    }
  }

  const raw = (req: FastifyRequest): Record<string, unknown> => {
    const b = req.body;
    return b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  };

  app.get<{ Querystring: { owner?: string } }>(SPOT_ORDERS_PATH, privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (s) => ({ orders: await s.list(principal, req.query.owner ?? '') }));
  });

  app.post(SPOT_ORDERS_PATH, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(
      reply,
      (s) => s.create(principal, raw(req), deps.regionOf?.(req) ?? ''),
      (v) => ((v as { restsOn?: string }).restsOn === 'engine' ? 201 : 200),
    );
  });

  app.post(`${SPOT_ORDERS_PATH}/review`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, (s) => s.review(principal, raw(req)));
  });

  app.patch<{ Params: { id: string } }>(`${SPOT_ORDERS_PATH}/:id`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, (s) => s.modify(principal, req.params.id, raw(req)));
  });

  app.delete<{ Params: { id: string } }>(`${SPOT_ORDERS_PATH}/:id`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, (s) => s.cancel(principal, req.params.id));
  });

  app.get<{ Querystring: { owner?: string } }>('/api/v1/venue/spot-agent', privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, (s) => s.agent(principal, req.query.owner ?? ''));
  });

  app.post('/api/v1/venue/spot-agent/prepare', privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    const owner = raw(req).owner;
    return answer(reply, (s) => s.prepareAgent(principal, typeof owner === 'string' ? owner : ''));
  });
}
