import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext, s2sFromEnv, verifyServiceRequest } from '@intafaced/contracts';
import { JetStreamEventBus } from '@intafaced/events';
import { registerTestAgeDoor, testAgeDoorOpen } from '@intafaced/service-kit';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { env } from './env.js';
import { startPasses } from './passes.js';
import { createCampaignsRouter, type CampaignsRouter } from './router.js';
import type { SubscriptionGroup } from './subscriptions.js';
import { ageDistributionRun, ageReward } from './test-age-door.js';
import { PayFaults, TEST_PAY_FAULT_PATH, payFaultInputSchema } from './test-pay-fault.js';
import { wireCampaigns } from './wiring.js';

registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-campaigns: campaigns and joining them, task campaigns and their rewards, seasons, limited drops and the TGE claim.
 * This file is the process only: HTTP, the bus connection and shutdown. What the service is made of (its services,
 * recurring passes, bus subscriptions, readiness and boot warnings) is `wiring.ts`; a new feature changes that and its
 * own module, never this file (project-state#2730).
 */
// The TEST age door (packages/service-kit test-age.ts): off unless TEST_AGE_DOOR=on, which refuses to start outside a
// TEST stack, so it is read before anything opens.
const testAgeDoor = testAgeDoorOpen(process.env);
// TEST pay faults (test-pay-fault.ts): set only through the door below, which opens only where the age door does.
const payFaults = new PayFaults();
const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  onnotice: () => undefined,
});
const s2s = s2sFromEnv(env, 'svc-campaigns');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });
const wiring = wireCampaigns({ sql, log: app.log, s2sKey, payFaults });

const appRouter = createCampaignsRouter(wiring.services);
// svc-trade's fee-saver ask (`service.feeSaver`, J-campaigns-09) is a service call: the caller is named by its own key,
// or by the shared secret where keys are not wired.
const edgeContext = createEdgeContext({
  secret: env.EDGE_PRINCIPAL_SECRET,
  ...edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  ...(s2s.serviceVerifier && s2s.s2sMode ? { serviceVerifier: s2s.serviceVerifier, s2sMode: s2s.s2sMode } : {}),
});

let bus: JetStreamEventBus | null = null;

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async (_req, reply) => {
  try {
    await sql`SELECT 1`;
    return {
      ok: true,
      service: env.SERVICE_NAME,
      database: 'ok',
      ...wiring.readiness(),
      bus: bus ? 'attached' : 'unreachable',
    };
  } catch {
    return reply.code(503).send({ ok: false, service: env.SERVICE_NAME, database: 'unavailable' });
  }
});

// Its own plugin scope: the raw body its signature check needs is kept for this one route, and every other route reads
// JSON as before.
await app.register(async (scope) => {
  registerTestAgeDoor(scope, {
    open: testAgeDoor,
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: s2s.serviceVerifier && s2s.s2sMode ? { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } : undefined,
    subjects: { reward: ageReward(sql), distribution: ageDistributionRun(sql) },
  });
  // The TEST pay-fault door (J-campaigns-19 #1 #2): the next payment of one reward meets one fault on the TEST chain.
  // Open only where the age door is, behind the same signed service call (svc-edge's own key refused).
  scope.post(TEST_PAY_FAULT_PATH, async (req, reply) => {
    const auth = verifyServiceRequest(req, {
      verifier: s2s.serviceVerifier,
      mode: s2s.s2sMode,
      legacySecret: env.INTERNAL_SERVICE_SECRET,
      bodyBindMode: 'require',
    });
    if (auth.service === null || auth.service === 'svc-edge') {
      return reply
        .code(401)
        .send({ error: 'test_pay_fault.unauthenticated', message: 'the TEST pay-fault door answers a signed service call only' });
    }
    if (!testAgeDoor) {
      return reply
        .code(403)
        .send({ error: 'test_pay_fault.door_closed', message: 'the TEST pay-fault door is closed: TEST_AGE_DOOR is not on' });
    }
    const parsed = payFaultInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'test_pay_fault.invalid', message: parsed.error.message });
    payFaults.set(parsed.data.rewardKey, parsed.data.fault);
    req.log.warn({ ...parsed.data, caller: auth.service }, 'TEST pay fault set');
    return reply.code(200).send({ ...parsed.data, label: 'TEST' });
  });
});

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    // The voucher attempt limit counts per source address: the one svc-edge resolved and forwarded as x-real-ip.
    createContext: ({ req }) => {
      const forwarded = req.headers['x-real-ip'];
      return { ...edgeContext(req), sourceAddress: (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.trim() || null };
    },
  } satisfies FastifyTRPCPluginOptions<CampaignsRouter>['trpcOptions'],
});

/**
 * The bus. A failed connect, or a failed attach of the first subscription group, closes the connection and is tried
 * again: the durable consumers pick the events up from their streams once they attach. Every later group attaches on its
 * own and, if its stream is missing, is tried again on its own while the rest keep running.
 */
const BUS_RETRY_MS = 15_000;
const retries = new Set<NodeJS.Timeout>();
let stopping = false;
function retry(run: () => void): void {
  if (stopping) return;
  const timer = setTimeout(() => {
    retries.delete(timer);
    run();
  }, BUS_RETRY_MS);
  timer.unref();
  retries.add(timer);
}
async function attachGroup(connected: JetStreamEventBus, group: SubscriptionGroup): Promise<void> {
  try {
    await group.attach(connected);
  } catch (err) {
    app.log.error({ err }, `svc-campaigns could not attach ${group.what}`);
    if (bus === connected) retry(() => void attachGroup(connected, group));
  }
}
async function attachBus(): Promise<void> {
  const [first, ...rest] = wiring.subscriptions;
  let connected: JetStreamEventBus | null = null;
  try {
    connected = await JetStreamEventBus.connect({
      servers: env.NATS_URL,
      producer: env.SERVICE_NAME,
      streamPrefix: env.NATS_STREAM_PREFIX,
    });
    if (first) await first.attach(connected);
    bus = connected;
    for (const group of rest) void attachGroup(connected, group);
  } catch (err) {
    app.log.error({ err }, `svc-campaigns could not attach ${first?.what ?? 'to the bus'}`);
    await connected?.close().catch(() => undefined);
    retry(() => void attachBus());
  }
}
await attachBus();

const passes = startPasses(wiring.passes, (err, name) => app.log.error({ err }, `${name} failed`));

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
for (const warning of wiring.warnings) app.log.warn(warning);
app.log.info({ port: env.HTTP_PORT, ...wiring.summary }, 'svc-campaigns ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      stopping = true;
      passes.stop();
      for (const timer of retries) clearTimeout(timer);
      await app.close();
      await bus?.close();
      await sql.end({ timeout: 2 });
      process.exit(0);
    })();
  });
}
