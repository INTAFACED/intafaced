import type { FastifyInstance } from 'fastify';
import { rawBodyOf, retainRawBody, verifyServiceHeaders } from '@intafaced/contracts';
import { correctionLinkSchema } from '@intafaced/exchange-contract';
import {
  MarketLifecycleLocalTestFixtureError,
  MarketLifecyclePublicationConflict,
  MarketLifecyclePublicationChainError,
  SqlMarketLifecycleEvidenceStore,
  lifecyclePublicationId,
  marketLifecyclePublicationSchema,
} from './market-lifecycle.js';

export const MARKET_LIFECYCLE_PATH = '/internal/market-lifecycle' as const;
export const MARKET_LIFECYCLE_CORRECTION_PATH = '/internal/market-lifecycle/corrections' as const;

export function registerMarketLifecycleRoutes(
  app: FastifyInstance,
  deps: {
    readonly internalSecret: string;
    readonly store: SqlMarketLifecycleEvidenceStore;
    /** Isolated tests install retention. Production index already called `retainRawBody`. */
    readonly installRawBody?: boolean;
  },
): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  const authorised = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
    verifyServiceHeaders(req.headers, deps.internalSecret, { rawBody: rawBodyOf(req), mode: 'require' }).service !== null;

  app.get<{ Params: { marketId: string } }>(`${MARKET_LIFECYCLE_PATH}/:marketId`, async (req, reply) => {
    if (!authorised(req)) return reply.code(401).send({ error: 'trade.unauthenticated' });
    const publication = await deps.store.readLatest(req.params.marketId);
    if (!publication) return reply.code(404).send({ error: 'trade.lifecycle_publication_unavailable' });
    const evidenceId = lifecyclePublicationId(publication.marketId, publication.idempotencyKey);
    return reply.send({ ok: true, evidenceId, reconciliationKey: evidenceId, publication });
  });

  app.post(MARKET_LIFECYCLE_PATH, async (req, reply) => {
    if (!authorised(req)) return reply.code(401).send({ error: 'trade.unauthenticated' });
    const parsed = marketLifecyclePublicationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'trade.lifecycle_publication_invalid', issues: parsed.error.issues });
    try {
      const publication = await deps.store.publish(parsed.data);
      return reply
        .code(200)
        .send({ ok: true, evidenceId: lifecyclePublicationId(publication.marketId, publication.idempotencyKey), publication });
    } catch (error) {
      if (error instanceof MarketLifecycleLocalTestFixtureError) return reply.code(409).send({ error: error.code });
      if (error instanceof MarketLifecyclePublicationConflict) return reply.code(409).send({ error: error.code });
      if (error instanceof MarketLifecyclePublicationChainError) return reply.code(409).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.post(MARKET_LIFECYCLE_CORRECTION_PATH, async (req, reply) => {
    if (!authorised(req)) return reply.code(401).send({ error: 'trade.unauthenticated' });
    const parsed = correctionLinkSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'trade.lifecycle_correction_invalid', issues: parsed.error.issues });
    const correction = await deps.store.appendCorrection(parsed.data);
    return reply.code(200).send({ ok: true, correction });
  });
}
