/**
 * The REST routes of a person's own agent trading their venue sub-account under an allowance (J-agents-08 #3 to #7;
 * src/venue/own-agent-trading.ts), for the signed-in person:
 *
 *   GET  /api/v1/venue/own-agents/:agentId/allowances                     the agent's allowances, read back from the venue
 *   POST /api/v1/venue/own-agents/:agentId/allowances                     { allowanceId, owner, subAccount, amount, period }
 *   POST /api/v1/venue/own-agents/:agentId/allowances/:id/submit          { actionKey, signature }: the wallet's signature
 *   POST /api/v1/venue/own-agents/:agentId/allowances/:id/abandon         the wallet rejected the agent permission
 *   POST /api/v1/venue/own-agents/:agentId/allowances/:id/revoke          admission ends at once; the venue's revoke is next
 *   POST /api/v1/venue/own-agents/:agentId/orders/preview                 { side, base, size, type, price? }: nothing is sent
 *   POST /api/v1/venue/own-agents/:agentId/orders                         { orderId, side, base, size, type, price? }
 *   GET  /api/v1/venue/own-agents/:agentId/orders                         the agent's orders, read back by client order id
 *
 * Reads need trade:read, writes trade:write, every route the trade jurisdiction and the person's own session (never an
 * API key). Amounts travel as decimal strings. A refusal answers with `intafacedCode` (`agents.*`, or the door's
 * `trade.venue.*`) and what it names.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { VenueWireError, decodeVenueWire, encodeVenueWire, type VenueSignature } from '@intafaced/venue-contracts';
import { privateRead, privateWrite } from '../route-inventory.js';
import { agentAccountReply } from './agent-account-rest.js';
import type { OwnAgentTrading } from './own-agent-trading.js';
import { UserVenueDoorError } from './user-venue-door.js';
import { refusedAgentKey, venueRefusalReply, type UserVenueRestDeps } from './user-venue-rest.js';

export const OWN_AGENTS_PATH = '/api/v1/venue/own-agents';

export function attachOwnAgentTradingRoutes(app: FastifyInstance, trading: OwnAgentTrading | null, deps: UserVenueRestDeps): void {
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

  async function answer(reply: FastifyReply, run: (t: OwnAgentTrading) => Promise<unknown>, status = 200) {
    try {
      if (!trading) {
        throw new UserVenueDoorError(
          'the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)',
          'trade.user_venue_off',
          404,
        );
      }
      return reply.code(status).send(encodeVenueWire(await run(trading)));
    } catch (error) {
      return agentAccountReply(reply, error);
    }
  }

  // The body as sent: amounts stay decimal strings, read by own-agent-trading.ts itself, so a blank amount is refused
  // naming its field (#4) rather than as a malformed wire amount. Only a signature is decoded from the venue's wire.
  function body(req: FastifyRequest): Record<string, unknown> {
    const raw = req.body ?? {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new VenueWireError('the body must be a JSON object');
    return raw as Record<string, unknown>;
  }

  type Agent = { Params: { agentId: string } };
  type Allowance = { Params: { agentId: string; id: string } };

  app.get<Agent>(`${OWN_AGENTS_PATH}/:agentId/allowances`, privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (t) => ({ allowances: await t.list(principal, req.params.agentId) }));
  });

  app.post<Agent>(`${OWN_AGENTS_PATH}/:agentId/allowances`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (t) => t.grant(principal, req.params.agentId, body(req)));
  });

  app.post<Allowance>(`${OWN_AGENTS_PATH}/:agentId/allowances/:id/submit`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (t) => {
      const b = decodeVenueWire<{ actionKey?: string; signature?: VenueSignature }>(body(req));
      return t.submit(principal, req.params.agentId, req.params.id, b.actionKey, b.signature as VenueSignature);
    });
  });

  app.post<Allowance>(`${OWN_AGENTS_PATH}/:agentId/allowances/:id/abandon`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (t) => t.abandon(principal, req.params.agentId, req.params.id));
  });

  app.post<Allowance>(`${OWN_AGENTS_PATH}/:agentId/allowances/:id/revoke`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (t) => t.revoke(principal, req.params.agentId, req.params.id));
  });

  app.post<Agent>(`${OWN_AGENTS_PATH}/:agentId/orders/preview`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (t) => t.preview(principal, req.params.agentId, body(req)));
  });

  // An answer that is not definite is 202: retry the same orderId, which reads the venue's record first and never signs again.
  app.post<Agent>(`${OWN_AGENTS_PATH}/:agentId/orders`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    try {
      if (!trading) {
        throw new UserVenueDoorError(
          'the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)',
          'trade.user_venue_off',
          404,
        );
      }
      const view = await trading.place(principal, req.params.agentId, body(req));
      return reply.code(view.state === 'accepted' ? 200 : 202).send(encodeVenueWire(view));
    } catch (error) {
      return agentAccountReply(reply, error);
    }
  });

  app.get<Agent>(`${OWN_AGENTS_PATH}/:agentId/orders`, privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (t) => ({ orders: await t.orders(principal, req.params.agentId) }));
  });
}
