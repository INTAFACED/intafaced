/**
 * The spot grid bot's public API (CB-bots-api-signal-09, -10; J-copy-bots-otc-19 #1, #4): the same `GridService` the
 * web's `trade.bots.grid.*` doors call, so a key gets the web's rules, codes and idempotency.
 *
 *   GET  /api/v1/bots/grid                scope: trade:read   (the caller's bots, newest first)
 *   GET  /api/v1/bots/grid/:id            scope: trade:read
 *   POST /api/v1/bots/grid                scope: trade:write + jurisdiction(module=trade)  (idempotent on clientId)
 *   POST /api/v1/bots/grid/:id/stop       scope: trade:write + jurisdiction  (settlement `keep`: the base bought stays)
 *   POST /api/v1/bots/grid/:id/withdraw   scope: trade:write + jurisdiction  (identity's step-up first, as in the web)
 *
 * The spot grid is neutral: `direction` may be left out or be `neutral`; long and short refuse
 * `trade.grid_direction_not_built`. A stop keeps what the bot bought (`settlement: keep`, the default); selling it back
 * refuses `trade.grid_settlement_not_built`. Refusals carry the service's own code as `intafacedCode`, with the web's
 * status: a field 400, verification and step-up 403, a missing bot 404, a reused key with another body 409.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import { TRPCError } from '@intafaced/contracts';
import { privateRead, privateWrite } from '../route-inventory.js';
import { GridError } from './errors.js';
import type { GridBotView, GridService, GridWithdrawalView } from './grid-service.js';
import { gridTrpcError } from './router.js';

export interface GridRestDeps {
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null;
  requireTradeJurisdiction: (req: FastifyRequest, reply: FastifyReply, principal: Principal) => boolean;
}

const decimal = z.string().max(64).optional().nullable();

const createBody = z.object({
  clientId: z.string(),
  symbol: z.string().min(3).max(64),
  direction: z.string().max(16).optional(),
  lowerPrice: decimal,
  upperPrice: decimal,
  grids: z.number().int().optional().nullable(),
  investment: decimal,
});

const stopBody = z.object({ settlement: z.string().max(16).optional() }).optional();

const withdrawBody = z.object({
  requestId: z.string(),
  asset: z.string().min(2).max(16),
  amount: decimal,
  stepUpApprovalId: z.string().max(128).optional().nullable(),
});

const HTTP_STATUS: Record<string, [number, string]> = {
  NOT_FOUND: [404, 'NotFound'],
  CONFLICT: [409, 'BadRequest'],
  FORBIDDEN: [403, 'PermissionDenied'],
  SERVICE_UNAVAILABLE: [503, 'ExchangeNotAvailable'],
  BAD_REQUEST: [400, 'BadRequest'],
};

/** A bot as the API reads it: `id` and `state` first, then every field the web's view carries. */
export function presentGridBot(view: GridBotView) {
  return { id: view.botId, state: view.status, ...view };
}

export function presentGridWithdrawal(view: GridWithdrawalView) {
  return { id: view.withdrawalId, ...view };
}

function refuse(reply: FastifyReply, error: unknown) {
  const mapped = gridTrpcError(error);
  if (!(mapped instanceof TRPCError)) throw error;
  const [status, code] = HTTP_STATUS[mapped.code] ?? [400, 'BadRequest'];
  const cause = mapped.cause as { code?: unknown } | undefined;
  return reply.code(status).send({ code, message: mapped.message, intafacedCode: typeof cause?.code === 'string' ? cause.code : null });
}

function invalid(reply: FastifyReply, message: string) {
  return refuse(reply, new GridError(message, 'trade.grid_request_invalid'));
}

export function attachGridRestRoutes(app: FastifyInstance, grid: GridService | undefined, deps: GridRestDeps): void {
  async function answer(reply: FastifyReply, run: (g: GridService) => Promise<unknown>) {
    try {
      if (!grid) throw new GridError('The grid bot service is not mounted', 'trade.grid_unavailable');
      return reply.code(200).send(await run(grid));
    } catch (error) {
      return refuse(reply, error);
    }
  }

  app.get('/api/v1/bots/grid', privateRead, async (req, reply) => {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return;
    return answer(reply, async (g) => (await g.list(principal)).map(presentGridBot));
  });

  app.get<{ Params: { id: string } }>('/api/v1/bots/grid/:id', privateRead, async (req, reply) => {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return;
    return answer(reply, async (g) => presentGridBot(await g.get(principal, req.params.id)));
  });

  app.post('/api/v1/bots/grid', privateWrite, async (req, reply) => {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal || !deps.requireTradeJurisdiction(req, reply, principal)) return;
    const body = createBody.safeParse(req.body);
    if (!body.success) return invalid(reply, `The grid request is malformed: ${body.error.issues[0]?.message ?? 'invalid body'}`);
    const { direction } = body.data;
    if (direction !== undefined && direction !== 'neutral') {
      return refuse(reply, new GridError(`A ${direction} grid is not built: the spot grid is neutral`, 'trade.grid_direction_not_built'));
    }
    return answer(reply, async (g) =>
      presentGridBot(
        await g.create(principal, {
          clientRequestId: body.data.clientId,
          symbol: body.data.symbol,
          lowerPrice: body.data.lowerPrice,
          upperPrice: body.data.upperPrice,
          gridCount: body.data.grids,
          investment: body.data.investment,
        }),
      ),
    );
  });

  app.post<{ Params: { id: string } }>('/api/v1/bots/grid/:id/stop', privateWrite, async (req, reply) => {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal || !deps.requireTradeJurisdiction(req, reply, principal)) return;
    const body = stopBody.safeParse(req.body ?? undefined);
    if (!body.success) return invalid(reply, 'The stop request is malformed');
    const settlement = body.data?.settlement ?? 'keep';
    if (settlement !== 'keep') {
      return refuse(
        reply,
        new GridError(`Settlement ${settlement} is not built: a stop keeps what the bot bought`, 'trade.grid_settlement_not_built'),
      );
    }
    return answer(reply, async (g) => presentGridBot(await g.stop(principal, req.params.id)));
  });

  app.post<{ Params: { id: string } }>('/api/v1/bots/grid/:id/withdraw', privateWrite, async (req, reply) => {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal || !deps.requireTradeJurisdiction(req, reply, principal)) return;
    const body = withdrawBody.safeParse(req.body);
    if (!body.success) return invalid(reply, `The withdrawal request is malformed: ${body.error.issues[0]?.message ?? 'invalid body'}`);
    return answer(reply, async (g) => presentGridWithdrawal(await g.withdrawProfit(principal, { botId: req.params.id, ...body.data })));
  });
}
