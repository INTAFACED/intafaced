import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext } from '@intafaced/contracts';
import { JetStreamEventBus } from '@intafaced/events';
import { env } from './env.js';
import { BlueprintService } from './blueprint-service.js';
import { HttpNeuralEngineClient } from './engine/http-engine.js';
import { MockNeuralEngine } from './engine/mock-engine.js';
import type { NeuralEngineClient } from './engine/neural-engine.js';
import { UnconfiguredCardRenderer, type CardRenderer } from './card/card-renderer.js';
import { HttpCardRenderer } from './card/http-renderer.js';
import { blueprintReadiness } from './readiness.js';
import { createBlueprintRouter, type BlueprintRouter } from './router.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';

// §9 — register the TracerProvider before the first span is created.
// `@opentelemetry/api` alone is a no-op: without this call every span in
// ./tracing.ts is built, tagged and then discarded before it reaches the
// collector. Tracers grabbed at module scope resolve lazily through the proxy
// provider, so registering here still captures them.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-blueprint — the Identity Blueprint (§7.1).
 *
 * Phase 4. Onboarding intelligence consumed as an internal service over an HTTP
 * contract, plus crew matching, mentor shortlists, and the export/erase pair
 * §7.2 requires.
 */

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'blueprint,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM blueprint.blueprints LIMIT 1`.catch(() => {
  throw new Error('blueprint schema is missing — run migrations before starting svc-blueprint');
});

const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['blueprint'],
});

/**
 * The engine is chosen explicitly, never by fallback.
 *
 * A service that silently degrades to the mock when the real engine is
 * unreachable would hand stub profiles to real people and look healthy doing
 * it. `BLUEPRINT_ENGINE_MODE` is the switch, and it is loud.
 */
const engine: NeuralEngineClient = (() => {
  if (env.BLUEPRINT_ENGINE_MODE === 'mock') return new MockNeuralEngine();
  const baseUrl = env.BLUEPRINT_ENGINE_URL;
  if (!baseUrl) {
    throw new Error('BLUEPRINT_ENGINE_URL is unset — will not invent http://host.docker.internal:4108 as live');
  }
  return new HttpNeuralEngineClient({
    baseUrl,
    timeoutMs: env.BLUEPRINT_ENGINE_TIMEOUT_MS,
    ...(env.BLUEPRINT_ENGINE_API_KEY ? { apiKey: env.BLUEPRINT_ENGINE_API_KEY } : {}),
  });
})();

/**
 * The card rasterizer, chosen the same way and for the same reason.
 *
 * Unset URL is not an error and not a degraded mode — the vector card is
 * complete without it (see `card/compose.ts`). What `UnconfiguredCardRenderer`
 * guarantees is that nobody downstream receives a PNG URL that does not resolve.
 */
const cardRenderer: CardRenderer = env.BLUEPRINT_CARD_RENDERER_URL
  ? new HttpCardRenderer({
      baseUrl: env.BLUEPRINT_CARD_RENDERER_URL,
      timeoutMs: env.BLUEPRINT_CARD_RENDERER_TIMEOUT_MS,
      ...(env.BLUEPRINT_CARD_RENDERER_API_KEY ? { apiKey: env.BLUEPRINT_CARD_RENDERER_API_KEY } : {}),
    })
  : new UnconfiguredCardRenderer();

const blueprint = new BlueprintService(sql, engine, bus, cardRenderer, {
  crewCapacity: env.BLUEPRINT_CREW_CAPACITY,
  mentorShortlistSize: env.BLUEPRINT_MENTOR_SHORTLIST_SIZE,
  season: env.BLUEPRINT_SEASON,
});

export const appRouter = createBlueprintRouter(blueprint);
export type AppRouter = typeof appRouter;

// Built before the listener opens: a service that cannot authenticate the edge
// must fail to start, not start and serve every request as anonymous.
const edgeContext = createEdgeContext({
  secret: env.EDGE_PRINCIPAL_PUBLIC_KEY ?? env.EDGE_PRINCIPAL_SECRET,
  serviceName: env.SERVICE_NAME,
});

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));

/**
 * Process readiness. Engine `usable` is reported, not a gate — see
 * `blueprintReadiness`. The card renderer is reported but does NOT gate
 * readiness: a card can be produced without a rasterizer, and refusing traffic
 * because the PNG rail is absent would take down onboarding over a share image.
 */
app.get('/ready', async () =>
  blueprintReadiness({
    engine,
    engineMode: env.BLUEPRINT_ENGINE_MODE,
    cardRenderer,
    cardRendererConfigured: Boolean(env.BLUEPRINT_CARD_RENDERER_URL),
  }),
);

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    // The edge terminates auth and forwards the resolved principal; this
    // service never parses a token itself (§4.1 owns that). It does verify the
    // edge's signature over that principal — see packages/contracts/src/edge.ts
    // for why an unsigned header makes every scope check decorative.
    createContext: ({ req }) => edgeContext(req),
  } satisfies FastifyTRPCPluginOptions<BlueprintRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info({ port: env.HTTP_PORT, engineMode: env.BLUEPRINT_ENGINE_MODE, season: env.BLUEPRINT_SEASON }, 'svc-blueprint ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await bus.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
