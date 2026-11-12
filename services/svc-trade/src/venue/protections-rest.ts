/**
 * The REST routes of a position's protections on the person's own venue account (J-derivatives-03; src/venue/protections.ts):
 *
 *   GET    /api/v1/venue/protections?owner=             every protection: the venue's trigger orders and our engine's stops
 *   POST   /api/v1/venue/protections                    { owner, symbol, kind, side, quantity, triggerPrice?, limitPrice?,
 *                                                         trailingDistance?, triggerSource, clientOrderId, attachTo? }:
 *                                                         a kind the venue takes answers the unsigned order for the wallet
 *                                                         (sent through /api/v1/venue/submit); one it lacks answers 201 armed
 *                                                         on our engine
 *   DELETE /api/v1/venue/protections/:id                an engine stop that has not fired
 *   GET    /api/v1/venue/protection-agent?owner=        the protection key and whether the venue lists it approved
 *   POST   /api/v1/venue/protection-agent/prepare       { owner }: the unsigned approval of that key, for the wallet
 *
 * Reads need trade:read, writes trade:write, and every route the trade jurisdiction. Amounts travel as decimal strings.
 * A refusal answers its code as `error` and `intafacedCode`, with its words as `message`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { encodeVenueWire } from '@intafaced/venue-contracts';
import { privateRead, privateWrite } from '../route-inventory.js';
import { ProtectionError, type VenueProtections } from './protections.js';
import { UserVenueDoorError } from './user-venue-door.js';
import { venueRefusalReply, type UserVenueRestDeps } from './user-venue-rest.js';

export const PROTECTIONS_PATH = '/api/v1/venue/protections';

export function attachProtectionRoutes(app: FastifyInstance, protections: VenueProtections | null, deps: UserVenueRestDeps): void {
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

  async function answer(
    reply: FastifyReply,
    run: (p: VenueProtections) => Promise<unknown>,
    statusOf: (value: unknown) => number = () => 200,
  ) {
    try {
      if (!protections) {
        throw new UserVenueDoorError(
          'the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)',
          'trade.user_venue_off',
          404,
        );
      }
      const value = await run(protections);
      return reply.code(statusOf(value)).send(encodeVenueWire(value));
    } catch (error) {
      if (error instanceof ProtectionError) {
        return reply.code(error.status).send({ code: 'BadRequest', error: error.code, intafacedCode: error.code, message: error.message });
      }
      return venueRefusalReply(reply, error);
    }
  }

  const raw = (req: FastifyRequest): Record<string, unknown> => {
    const b = req.body;
    return b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  };

  app.get<{ Querystring: { owner?: string } }>(PROTECTIONS_PATH, privateRead, async (req, reply) => {
    const principal = admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (p) => ({ protections: await p.list(principal, req.query.owner ?? '') }));
  });

  app.post(PROTECTIONS_PATH, privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    // A stop armed on our engine is made here (201); a venue trigger order is made only once the wallet signs it (200).
    return answer(
      reply,
      (p) => p.create(principal, raw(req)),
      (v) => ((v as { restsOn?: string }).restsOn === 'engine' ? 201 : 200),
    );
  });

  app.delete<{ Params: { id: string } }>(`${PROTECTIONS_PATH}/:id`, privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, (p) => p.cancel(principal, req.params.id));
  });

  app.get<{ Querystring: { owner?: string } }>('/api/v1/venue/protection-agent', privateRead, async (req, reply) => {
    const principal = admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, (p) => p.agent(principal, req.query.owner ?? ''));
  });

  app.post('/api/v1/venue/protection-agent/prepare', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    const owner = raw(req).owner;
    return answer(reply, (p) => p.prepareAgent(principal, typeof owner === 'string' ? owner : ''));
  });
}
