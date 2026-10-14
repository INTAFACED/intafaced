import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext } from '@intafaced/contracts';
import { deskVsAgentSplit } from './desk-vs-agent-split.js';
import { supportHealthHonesty, supportStoreHonesty } from './identity-grounding-honesty.js';
import { describeSupportSettlement } from './settlement-refuse.js';
import type { SupportRouter } from './router.js';
import { ticketKbLoopObservedInLiveCompose, type TicketKbLoopSnapshot } from './ticket-kb-loop-observation.js';

export type SupportHttpAppDeps = {
  router: SupportRouter;
  edgeContext: ReturnType<typeof createEdgeContext>;
  serviceName: string;
  identitySecret: string | undefined;
  loop: { snapshot(): TicketKbLoopSnapshot };
  logLevel?: string;
};

/**
 * The Fastify/tRPC mount `index.ts` listens on. Tests inject this same app
 * so a store-only suite cannot green a procedure nothing registered.
 */
export async function createSupportHttpApp(deps: SupportHttpAppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logLevel ? { level: deps.logLevel } : false,
    maxParamLength: 5_000,
  });

  app.get('/health', async () => supportHealthHonesty({ serviceName: deps.serviceName, identitySecret: deps.identitySecret }));

  app.get('/ready', async () => {
    const split = deskVsAgentSplit();
    const settlement = describeSupportSettlement();
    const loop = deps.loop.snapshot();
    const health = supportHealthHonesty({
      serviceName: deps.serviceName,
      identitySecret: deps.identitySecret,
    });
    return {
      ready: true as const,
      stage: split.stage,
      canSettle: settlement.canSettle,
      store: supportStoreHonesty(),
      accountStateSource: split.accountStateSource,
      deskMountain: split.deskMountain,
      agentAssist: split.agentAssist,
      deskStandalone: split.deskStandalone,
      identityGroundingWired: health.identityGroundingWired,
      identitySecretSet: health.identitySecretSet,
      identityGroundingRefuse: health.identityGroundingRefuse,
      identity: health.identity,
      // Live compose observation is Class X. This process reports its own
      // last successful ticket+KB timestamps (zeros until first success).
      ticketKbLoopObservedInLiveCompose: ticketKbLoopObservedInLiveCompose(),
      lastTicketCreateAtMs: loop.lastTicketCreateAtMs,
      lastKbSearchAtMs: loop.lastKbSearchAtMs,
      lastKbGetAtMs: loop.lastKbGetAtMs,
    };
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: deps.router,
      createContext: ({ req }) => deps.edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<SupportRouter>['trpcOptions'],
  });

  await app.ready();
  return app;
}
