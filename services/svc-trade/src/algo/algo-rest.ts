/**
 * The algo order public API (CB-execution-08; J-copy-bots-otc-19 #7): the same `TradeService` algo calls the web's
 * `trade.algo.*` doors make, so a key gets the web's rules, codes and idempotency.
 *
 *   POST  /api/v1/algo/:kind         scope: trade:write + jurisdiction(module=trade)  (idempotent on clientAlgoId)
 *   GET   /api/v1/algo               scope: trade:read   (the caller's parents, newest first, with a cursor)
 *   GET   /api/v1/algo/:id           scope: trade:read   (the parent and its filled quantity)
 *   PATCH /api/v1/algo/:id           scope: trade:write + jurisdiction  (refused: parameters are fixed at create)
 *   POST  /api/v1/algo/:id/cancel    scope: trade:write + jurisdiction
 *
 * The kinds an engine runs are twap, vwap, pov and chase. Trigger, OCO, conditional and trailing refuse
 * `trade.algo_kind_not_built` before anything is asked. Amend refuses `trade.algo_params_immutable` for the caller's own
 * parent, as the web offers no amend; another person's parent is not found. A create whose answer was lost is sent
 * again with the same clientAlgoId and answers the parent it made. Refusals use the shared CCXT mapping.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { orderSideSchema } from '@intafaced/exchange-contract';
import { parseAmount } from '@intafaced/ledger-client';
import { invalidOrder, toCcxtError } from '../ccxt-errors.js';
import { privateRead, privateWrite } from '../route-inventory.js';
import { TradeError } from '../spot/types.js';
import type { TradeService } from '../spot/trade-service.js';
import { presentAlgo } from './present.js';
import { POV_BASES } from './types.js';
import { MAX_ALGO_SEED } from './schedule.js';

export type AlgoRestPort = Pick<TradeService, 'createTwap' | 'getAlgo' | 'algoProgress' | 'algoList' | 'cancelAlgo'>;

export interface AlgoRestDeps {
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null;
  requireTradeJurisdiction: (req: FastifyRequest, reply: FastifyReply, principal: Principal) => boolean;
}

/** The kinds an engine runs (the web's `algo.createTwap` kinds). */
export const ALGO_API_KINDS = ['twap', 'vwap', 'pov', 'chase'] as const;
/** The reference's algo kinds no engine runs yet: each refuses by name. */
export const ALGO_API_KINDS_NOT_BUILT = ['trigger', 'oco', 'conditional', 'trailing'] as const;

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');

const createBody = z.object({
  symbol: z.string().min(3),
  side: orderSideSchema,
  totalQty: decimal,
  durationMs: z.number().int().min(1_000).max(86_400_000),
  sliceIntervalMs: z.number().int().min(1_000).max(86_400_000),
  limitPrice: decimal.optional(),
  clientAlgoId: z.string().trim().min(1).max(48),
  participationBps: z.number().int().min(1).max(10_000).optional(),
  chaseDistanceBps: z.number().int().min(1).max(10_000).optional(),
  povBasis: z.enum(POV_BASES).optional(),
  randomSeed: z.number().int().min(0).max(MAX_ALGO_SEED).optional(),
});

const listQuery = z.object({
  status: z.string().max(32).optional(),
  kind: z.string().max(32).optional(),
  from: z.string().max(64).optional(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().max(256).optional(),
});

function refuse(reply: FastifyReply, error: unknown) {
  const mapped = toCcxtError(error);
  if (!mapped) throw error;
  const data = error instanceof TradeError ? error.data : undefined;
  return reply.code(mapped.status).send({ ...mapped.body, ...(data ? { data } : {}) });
}

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

  app.post<{ Params: { kind: string } }>('/api/v1/algo/:kind', privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    const kind = req.params.kind;
    if ((ALGO_API_KINDS_NOT_BUILT as readonly string[]).includes(kind)) {
      return refuse(
        reply,
        new TradeError(`A ${kind} algo order is not built: no engine runs it yet`, 'trade.algo_kind_not_built', { kind }),
      );
    }
    if (!(ALGO_API_KINDS as readonly string[]).includes(kind)) {
      const res = invalidOrder(`Unknown algo kind ${kind}: one of ${[...ALGO_API_KINDS, ...ALGO_API_KINDS_NOT_BUILT].join(', ')}`);
      return reply.code(res.status).send(res.body);
    }
    const body = createBody.safeParse(req.body);
    if (!body.success) return malformed(reply, body.error.issues);
    const input = body.data;
    return answer(reply, async (a) =>
      presentAlgo(
        await a.createTwap(principal, {
          symbol: input.symbol,
          side: input.side,
          totalQty: parseAmount(input.totalQty),
          durationMs: input.durationMs,
          sliceIntervalMs: input.sliceIntervalMs,
          limitPrice: input.limitPrice === undefined ? null : parseAmount(input.limitPrice),
          clientAlgoId: input.clientAlgoId,
          kind,
          participationBps: input.participationBps,
          povBasis: input.povBasis,
          randomSeed: input.randomSeed,
          chaseDistanceBps: input.chaseDistanceBps,
        }),
      ),
    );
  });

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
      const parent = await a.getAlgo(principal, req.params.id);
      const progress = await a.algoProgress(principal, req.params.id);
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
        'An algo order’s parameters are fixed when it is created. Cancel it and place a new one.',
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
}
