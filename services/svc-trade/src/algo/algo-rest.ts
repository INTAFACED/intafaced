/**
 * The algo order public API (CB-execution-08; J-copy-bots-otc-19 #7): the same `TradeService` algo calls the web's
 * `trade.algo.*` doors make, so a key gets the web's rules, codes and idempotency.
 *
 *   POST  /api/v1/algo               scope: trade:write + jurisdiction(module=trade)  (`kind` in the body; idempotent on clientAlgoId)
 *   GET   /api/v1/algo               scope: trade:read   (the caller's parents, newest first; `limit` is required)
 *   GET   /api/v1/algo/:id           scope: trade:read   (the parent and its filled quantity)
 *   PATCH /api/v1/algo/:id           scope: trade:write + jurisdiction  (refused: parameters are fixed at create)
 *   POST  /api/v1/algo/:id/cancel    scope: trade:write + jurisdiction
 *
 * The algo order API (SP-conditional-algo-04; J-cex-spot-15 #6) answers the same parents with one state for every kind
 * (`ALGO_API_STATES`: live, effective, partially_effective, canceled, order_failed) and amends:
 *
 *   POST   /api/v1/algo/orders       scope: trade:write + jurisdiction  (the create above)
 *   GET    /api/v1/algo/orders/:id   scope: trade:read   (the parent, its filled quantity and its state)
 *   PATCH  /api/v1/algo/orders/:id   scope: trade:write + jurisdiction  (a TWAP's totalQty down, or its triggerPrice while
 *                                    it waits; a larger quantity refuses trade.amend_qty_up)
 *   DELETE /api/v1/algo/orders/:id   scope: trade:write + jurisdiction  (cancel)
 *
 * The kinds an engine runs are twap, vwap, pov and chase. Trigger, OCO, conditional and trailing refuse
 * `trade.algo_kind_not_built` before anything is asked. Amend refuses `trade.algo_params_immutable` for the caller's own
 * parent on this door (amend is the algo order API's PATCH); another person's parent is not found. A create whose answer was lost is sent
 * again with the same clientAlgoId and answers the parent it made; the same id with another kind is a conflict. The
 * body is the web's (`algoCreateInputSchema`). Refusals use the shared CCXT mapping; the list's own refusals (an unset
 * or out-of-range limit, a bad cursor) answer 400, or 404 for a missing parent.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { invalidOrder, toCcxtError } from '../ccxt-errors.js';
import { privateRead, privateWrite } from '../route-inventory.js';
import { TradeError } from '../spot/types.js';
import type { TradeService } from '../spot/trade-service.js';
import { algoApiState, presentAlgo } from './present.js';
import type { TwapParent } from './types.js';
import { DeskError } from '../desk/errors.js';
import { ALGO_KINDS, algoCreateInputSchema } from './create-input.js';

export type AlgoRestPort = Pick<TradeService, 'createTwap' | 'getAlgo' | 'algoProgress' | 'algoList' | 'cancelAlgo' | 'amendAlgo'>;

export interface AlgoRestDeps {
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null;
  requireTradeJurisdiction: (req: FastifyRequest, reply: FastifyReply, principal: Principal) => boolean;
}

/** The reference's algo kinds no engine runs yet: each refuses by name. */
export const ALGO_API_KINDS_NOT_BUILT = ['trigger', 'oco', 'conditional', 'trailing'] as const;

const listQuery = z.object({
  status: z.string().max(32).optional(),
  kind: z.string().max(32).optional(),
  from: z.string().max(64).optional(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().max(256).optional(),
});

function refuse(reply: FastifyReply, error: unknown) {
  if (error instanceof DeskError) {
    const status = error.code.endsWith('_not_found') ? 404 : 400;
    return reply
      .code(status)
      .send({ code: status === 404 ? 'OrderNotFound' : 'BadRequest', message: error.message, intafacedCode: error.code });
  }
  const mapped = toCcxtError(error);
  if (!mapped) throw error;
  const data = error instanceof TradeError ? error.data : undefined;
  return reply.code(mapped.status).send({ ...mapped.body, ...(data ? { data } : {}) });
}

/** An amend's body: decimal strings only, at least one of them; nothing else is amended. */
const amendBody = z
  .object({
    totalQty: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional(),
    triggerPrice: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional(),
  })
  .strict()
  .refine((b) => b.totalQty !== undefined || b.triggerPrice !== undefined, { message: 'name a totalQty, a triggerPrice, or both' });

function malformed(reply: FastifyReply, issues: z.ZodIssue[]) {
  const issue = issues[0];
  const res = invalidOrder(`The algo request is malformed: ${issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid'}`);
  return reply.code(res.status).send(res.body);
}

export function attachAlgoRestRoutes(app: FastifyInstance, algo: AlgoRestPort | undefined, deps: AlgoRestDeps): void {
  /** The web's door rules: the scope, then for a write the trade jurisdiction (module=trade). */
  function admit(req: FastifyRequest, reply: FastifyReply, scope: Scope): Principal | null {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return null;
    try {
      requireScope(principal, scope);
    } catch (error) {
      refuse(reply, error);
      return null;
    }
    if (scope === 'trade:write' && !deps.requireTradeJurisdiction(req, reply, principal)) return null;
    return principal;
  }

  async function answer(reply: FastifyReply, run: (a: AlgoRestPort) => Promise<unknown>) {
    try {
      if (!algo) {
        return reply
          .code(503)
          .send({ code: 'ExchangeNotAvailable', message: 'The algo service is not mounted', intafacedCode: 'trade.algo_unavailable' });
      }
      return reply.code(200).send(await run(algo));
    } catch (error) {
      return refuse(reply, error);
    }
  }

  async function create(
    req: FastifyRequest,
    reply: FastifyReply,
    present: (a: AlgoRestPort, parent: TwapParent, principal: Principal) => Promise<unknown> | unknown,
  ) {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    const raw = (req.body ?? {}) as { kind?: unknown };
    // Left out means twap, as in the web; any other non-string kind is malformed, never quietly a twap.
    if (raw.kind !== undefined && typeof raw.kind !== 'string') {
      const res = invalidOrder('The algo request is malformed: kind: a string, one of the algo kinds');
      return reply.code(res.status).send(res.body);
    }
    const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : 'twap';
    if ((ALGO_API_KINDS_NOT_BUILT as readonly string[]).includes(kind)) {
      return refuse(
        reply,
        new TradeError(`A ${kind} algo order is not built: no engine runs it yet`, 'trade.algo_kind_not_built', { kind }),
      );
    }
    if (!(ALGO_KINDS as readonly string[]).includes(kind)) {
      const res = invalidOrder(`Unknown algo kind ${kind}: one of ${[...ALGO_KINDS, ...ALGO_API_KINDS_NOT_BUILT].join(', ')}`);
      return reply.code(res.status).send(res.body);
    }
    const body = algoCreateInputSchema.strict().safeParse({ ...raw, kind });
    if (!body.success) return malformed(reply, body.error.issues);
    const input = body.data;
    return answer(reply, async (a) => {
      const parent = await a.createTwap(principal, {
        symbol: input.symbol,
        side: input.side,
        totalQty: parseAmount(input.totalQty),
        durationMs: input.durationMs,
        sliceIntervalMs: input.sliceIntervalMs,
        limitPrice: input.limitPrice === undefined ? null : parseAmount(input.limitPrice),
        clientAlgoId: input.clientAlgoId,
        subAccountId: input.subAccountId,
        kind,
        participationBps: input.participationBps,
        povBasis: input.povBasis,
        randomSeed: input.randomSeed,
        triggerPrice: input.triggerPrice === undefined ? undefined : parseAmount(input.triggerPrice),
        chaseDistanceBps: input.chaseDistanceBps,
      });
      // A replay answers the parent the id already made; another kind under the same id is not that order.
      if (parent.kind !== kind) {
        throw new TradeError(`clientAlgoId ${input.clientAlgoId} already names a ${parent.kind} order`, 'trade.client_order_id_conflict', {
          algoId: parent.id,
          kind: parent.kind,
        });
      }
      return present(a, parent, principal);
    });
  }

  app.post('/api/v1/algo', privateWrite, (req, reply) => create(req, reply, (_a, parent) => presentAlgo(parent)));

  app.get<{ Querystring: Record<string, string> }>('/api/v1/algo', privateRead, async (req, reply) => {
    const principal = admit(req, reply, 'trade:read');
    if (!principal) return;
    const query = listQuery.safeParse(req.query ?? {});
    if (!query.success) return malformed(reply, query.error.issues);
    return answer(reply, (a) => a.algoList(principal, query.data));
  });

  app.get<{ Params: { id: string } }>('/api/v1/algo/:id', privateRead, async (req, reply) => {
    const principal = admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (a) => {
      const [parent, progress] = await Promise.all([a.getAlgo(principal, req.params.id), a.algoProgress(principal, req.params.id)]);
      return { ...presentAlgo(parent), filledQty: progress.filledQty };
    });
  });

  app.patch<{ Params: { id: string } }>('/api/v1/algo/:id', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => {
      // Not found for anyone else's id; the caller's own parent is refused by name.
      await a.getAlgo(principal, req.params.id);
      throw new TradeError(
        'This door does not amend an algo order. Amend a TWAP’s quantity down or its trigger with PATCH /api/v1/algo/orders/:id.',
        'trade.algo_params_immutable',
        { algoId: req.params.id },
      );
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/algo/:id/cancel', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => presentAlgo(await a.cancelAlgo(principal, req.params.id)));
  });

  /** One parent as the algo order API answers it: the parent, the sum of its children's fills, and its state. */
  async function withState(a: AlgoRestPort, parent: TwapParent, principal: Principal) {
    const progress = await a.algoProgress(principal, parent.id);
    return {
      ...presentAlgo(parent),
      filledQty: progress.filledQty,
      state: algoApiState(parent.status, parseAmount(progress.filledQty), parent.totalQty),
    };
  }

  app.post('/api/v1/algo/orders', privateWrite, (req, reply) => create(req, reply, withState));

  app.get<{ Params: { id: string } }>('/api/v1/algo/orders/:id', privateRead, async (req, reply) => {
    const principal = admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (a) => withState(a, await a.getAlgo(principal, req.params.id), principal));
  });

  app.patch<{ Params: { id: string } }>('/api/v1/algo/orders/:id', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    const body = amendBody.safeParse(req.body ?? {});
    if (!body.success) return malformed(reply, body.error.issues);
    const change = {
      ...(body.data.totalQty === undefined ? {} : { totalQty: parseAmount(body.data.totalQty) }),
      ...(body.data.triggerPrice === undefined ? {} : { triggerPrice: parseAmount(body.data.triggerPrice) }),
    };
    return answer(reply, async (a) => withState(a, await a.amendAlgo(principal, req.params.id, change), principal));
  });

  app.delete<{ Params: { id: string } }>('/api/v1/algo/orders/:id', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => withState(a, await a.cancelAlgo(principal, req.params.id), principal));
  });
}
