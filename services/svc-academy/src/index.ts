import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext, s2sFromEnv } from '@intafaced/contracts';
import { registerInternalCurriculumRoute } from './curriculum/internal-curriculum.js';
import { JetStreamEventBus } from '@intafaced/events';
import { env } from './env.js';
import { AcademyService } from './academy-service.js';
import { createHostRightsSource } from './host-rights.js';
import { createStakeSource } from './stake-source.js';
import { BusCertXpPublisher, NullCertXpPublisher, type CertXpPublisher } from './certs/xp-publish.js';
import { streamProviderFromEnv, streamReadyAnswer, type StreamProvider } from './stream/provider.js';
import { createAcademyRouter, type AcademyRouter } from './router.js';
import { createIdentityApprovalClient, unwiredApprovalConsumer } from './action-approval-consume.js';
import { videoGateFromEnv, videoStorageFromEnv } from './video/library.js';
import { createTradePublicPaperFlagPort } from './paper/market-flag-verify.js';
import { parseAmbassadorIfcPayLawJson, parseAmbassadorRevenueShareLawJson } from './ambassadors/ifc-pay-rate-law.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { createQuizAddressResolver } from './curriculum/course-quizzes.js';

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
 * svc-academy — live lobbies with capacity tiers (§8.3, §XIII).
 *
 * Phase 5. No ledger client and no LEDGER_URL: `academy` is `custodial: false`
 * and there is no credential in this process that could reach anything which
 * moves value.
 *
 * ONE PUBLISH, NO SUBSCRIBE. This header used to say "NO BUS CONNECTION
 * either", and the reason it gave was exact: the §8.3 event this service would
 * eventually emit is `intafaced.identity.xp.earned` on certification, and
 * connecting to NATS to publish nothing would add a boot dependency that can
 * fail in exchange for no capability at all. Certification has now shipped
 * (`certs/`), so there is a capability, and the connection buys it.
 *
 * The boot-dependency objection still stands, and is answered rather than
 * ignored: the connect is attempted, and a failure DEGRADES rather than kills.
 * Seats, presence, the 2D scene, the curriculum catalog and paper drills have
 * nothing to do with NATS, and taking svc-academy out of the fleet because a
 * cert award could not be published would trade the whole service for one
 * downstream side effect. `/ready` reports `xp.usable: false` and `grantCert`
 * returns `publisher_unavailable` — the same out-loud honesty the stream
 * provider gets, for the same reason. The award itself is recoverable: it is
 * keyed on the grant, so granting again re-publishes it (certs/xp-publish.ts).
 *
 * It still subscribes to nothing. `crew-events.ts` remains unmounted — a
 * consumer is a different decision from a producer, and this one is not it.
 */

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'academy,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM academy.rooms LIMIT 1`.catch(() => {
  throw new Error('academy schema is missing — run migrations before starting svc-academy');
});

// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves every call and door on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-academy');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;

const stakes = createStakeSource(env.TOKEN_URL, env.INTERNAL_SERVICE_SECRET, s2sKey);

/** §4.1 `lobbyHostRights` — who may open a room. Read at createRoom, fails closed. */
const hostRights = createHostRightsSource(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey);

/**
 * The provider is chosen explicitly, never by fallback.
 *
 * `none` is the only value this build accepts, and it is honest about what it
 * means: lobbies run as seats, presence and the 2D scene, and a request for a
 * stream credential is refused by name rather than answered with a token that
 * cannot connect (SOCKET §13 `socket.stream-provider`).
 */
const stream: StreamProvider = streamProviderFromEnv({
  provider: env.ACADEMY_STREAM_PROVIDER,
  url: env.LIVEKIT_URL,
  apiKey: env.LIVEKIT_API_KEY,
  apiSecret: env.LIVEKIT_API_SECRET,
  tokenTtlSeconds: env.LIVEKIT_TOKEN_TTL_SECONDS,
});

/**
 * The one publish: cert grant → `intafaced.identity.xp.earned`.
 *
 * `ownedStreams` is empty because academy owns no stream. `xpEarned` is declared
 * on the `identity` service, svc-identity creates that stream, and a producer
 * that also created it would be a second definition of somebody else's storage.
 *
 * A failed connect is caught, not fatal — see this file's header for why a
 * lobby must not go down with the bus, and certs/xp-publish.ts for why the
 * award it misses is recoverable rather than lost.
 */
const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
}).catch((err: unknown) => {
  console.error({ err, nats: env.NATS_URL }, 'svc-academy could not reach the bus — certification XP will not be published');
  return null;
});

const certXp: CertXpPublisher = bus
  ? new BusCertXpPublisher(bus, (err, grant) => console.error({ err, certId: grant.certId }, 'cert XP publish failed'))
  : new NullCertXpPublisher();

const academy = new AcademyService(
  sql,
  stakes,
  hostRights,
  stream,
  {
    maxRoomCapacity: env.ACADEMY_MAX_ROOM_CAPACITY,
    plannerTodoLimit: env.ACADEMY_PLANNER_TODO_LIMIT,
    outlineMaxSections: env.ACADEMY_OUTLINE_MAX_SECTIONS,
    outlineMaxItems: env.ACADEMY_OUTLINE_MAX_ITEMS,
    lessonImportMaxBytes: env.ACADEMY_LESSON_IMPORT_MAX_BYTES,
    mediaStorage: videoStorageFromEnv(env),
    uploadMaxBytes: env.ACADEMY_UPLOAD_MAX_BYTES,
    topicsListLimit: env.ACADEMY_TOPICS_LIST_LIMIT,
    graderLeaseSeconds: env.ACADEMY_GRADER_LEASE_SECONDS,
    gradeReportRows: env.ACADEMY_GRADE_REPORT_ROWS,
    bulkFileMaxBytes: env.ACADEMY_BULK_FILE_MAX_BYTES,
    certIssueSweepSeconds: env.ACADEMY_CERT_ISSUE_SWEEP_SECONDS,
    programmeMaxCourses: env.ACADEMY_PROGRAMME_MAX_COURSES,
    postMaxChars: env.ACADEMY_POST_MAX_CHARS,
    postImageMaxBytes: env.ACADEMY_POST_IMAGE_MAX_BYTES,
    messageMaxChars: env.ACADEMY_MESSAGE_MAX_CHARS,
    uploadVideoTypes: env.ACADEMY_UPLOAD_VIDEO_TYPES,
    uploadHandoutTypes: env.ACADEMY_UPLOAD_HANDOUT_TYPES,
    videoWatchThresholdSeconds: env.ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS,
    videoSaveEverySeconds: env.ACADEMY_VIDEO_POSITION_SAVE_SECONDS,
    tournamentEnabled: env.ACADEMY_TOURNAMENT_ENABLED,
    paperTradingEnabled: env.ACADEMY_PAPER_TRADING_ENABLED,
    paperMarketFlagPort: env.TRADE_URL
      ? createTradePublicPaperFlagPort({
          baseUrl: env.TRADE_URL,
          ...(env.ACADEMY_PAPER_MARKETS_LIMIT === undefined ? {} : { limit: env.ACADEMY_PAPER_MARKETS_LIMIT }),
        })
      : undefined,
  },
  certXp,
);

const actionApprovals = env.IDENTITY_URL
  ? createIdentityApprovalClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET)
  : unwiredApprovalConsumer();

export const appRouter = createAcademyRouter(
  academy,
  {
    ifcPayLaw: parseAmbassadorIfcPayLawJson(env.ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON),
    revenueShareLaw: parseAmbassadorRevenueShareLawJson(env.ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON),
  },
  {
    storage: videoStorageFromEnv(env),
    gate: videoGateFromEnv(env),
    stakeOf: (userId) => stakes.stakeOf(userId),
  },
  actionApprovals,
  env.ACADEMY_CERT_VERIFY_RATE_MAX !== undefined && env.ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS !== undefined
    ? { max: env.ACADEMY_CERT_VERIFY_RATE_MAX, windowSeconds: env.ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS }
    : null,
  env,
);
export type AppRouter = typeof appRouter;

// Built before the listener opens: a service that cannot authenticate the edge
// must fail to start, not start and serve every request as anonymous.
const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });

// AC-quizzes-01: built before the listener opens, so a malformed proxy range stops the service instead of reading no address.
const quizAddress = createQuizAddressResolver(env.ACADEMY_TRUSTED_PROXY_CIDRS);

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));

/**
 * Readiness reports the streaming provider rather than gating on it.
 *
 * A lobby without an SFU is a degraded lobby, not a dead service — seats,
 * presence, capacity, invites and the 2D scene canvas all work without one.
 * Reporting 503 would take the Academy out of the fleet over a feature the rest
 * of it does not need. Construction (URL+keys) is not a RoomService probe.
 * `usable` stays false until one exists; `constructed` / `configured` / `probed`
 * say the rest out loud.
 */
app.get('/ready', async () => ({
  ready: true,
  stream: streamReadyAnswer(stream, env.ACADEMY_STREAM_PROVIDER),
  // Same contract as `stream`: degraded is reported, not hidden. `usable: false`
  // means certifications still grant and their XP is not reaching the ladder.
  //
  // The URL is NOT echoed here the way ACADEMY_STREAM_PROVIDER is. That one is
  // an enum; NATS_URL can carry credentials (`nats://user:pass@host`), and
  // /ready is the least authenticated surface this service has.
  xp: { id: certXp.id, usable: certXp.usable, publishes: 'intafaced.identity.xp.earned' },
}));

registerInternalCurriculumRoute(
  app,
  env.INTERNAL_SERVICE_SECRET,
  env.INTERNAL_SERVICE_BODY_BIND,
  s2s.serviceVerifier && s2s.s2sMode ? { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } : undefined,
);

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    // The edge terminates auth and forwards the resolved principal; this
    // service never parses a token itself (§4.1 owns that). It does verify the
    // edge's signature over that principal — see packages/contracts/src/edge.ts
    // for why an unsigned header makes every scope check decorative.
    createContext: ({ req }) => {
      const ctx = edgeContext(req);
      const peer = (req as { ip?: unknown }).ip;
      return Object.assign(ctx, {
        clientAddress: typeof peer === 'string' ? peer.trim() : '',
        quizClientAddress: quizAddress(req.socket.remoteAddress, req.headers['x-intafaced-client-ip']),
      });
    },
  } satisfies FastifyTRPCPluginOptions<AcademyRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });

/**
 * AC-certificates-02: the issue sweep issues delayed certificates once due. One sweep at a time: a slow one is never
 * stacked under the next. Blank interval, no sweep, and delayed issue rules refuse `academy.cert_sweep_unset`.
 */
let sweeping: Promise<void> | null = null;
const certSweep =
  env.ACADEMY_CERT_ISSUE_SWEEP_SECONDS === undefined
    ? null
    : setInterval(() => {
        if (sweeping) return;
        sweeping = academy
          .issueDueCertificates()
          .then(
            () => undefined,
            (err: unknown) => app.log.error({ err }, 'certificate issue sweep failed; the next one retries'),
          )
          .finally(() => {
            sweeping = null;
          });
      }, env.ACADEMY_CERT_ISSUE_SWEEP_SECONDS * 1000);
certSweep?.unref();
app.log.info({ port: env.HTTP_PORT, stream: stream.id, xp: certXp.id, trpc: true }, 'svc-academy ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      if (certSweep) clearInterval(certSweep);
      // A sweep under way finishes before the pool closes, so no issue is cut off between its grant and its cleanup.
      await sweeping;
      await app.close();
      await bus?.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
