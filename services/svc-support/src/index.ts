import postgres from 'postgres';
import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext, s2sFromEnv } from '@intafaced/contracts';
import { env } from './env.js';
import { createAccountStateClient } from './account-state.js';
import { createTicketOrderClient, DarkTicketOrderSource } from './ticket-order.js';
import { createSupportHttpApp } from './http-app.js';
import { SqlGroupBook } from './desk-groups.js';
import { SqlPropertiesBook } from './desk-properties.js';
import { SqlLifecycleBook } from './ticket-lifecycle.js';
import { SqlStaffBook } from './desk-staff.js';
import { SupportService } from './support-service.js';
import { PostgresSupportStore } from './store.js';
import { createSupportRouter } from './router.js';
import { createTicketKbLoopObserver } from './ticket-kb-loop-observation.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';

// §9 — register the TracerProvider before the first span is created.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-support — tickets + KB + operator queue (ops.support).
 * Durable Postgres store. No ledger. No balances.
 */
const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'support,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM support.tickets LIMIT 1`.catch(() => {
  throw new Error('support schema is missing — run migrations before starting svc-support');
});

// Migration 0001 is checked separately from 0000. A desk booting on 0000 alone
// would serve tickets and silently record no history — the audit trail would be
// permanently empty and nothing would say why, which is the failure mode this
// whole slice exists to remove.
await sql`SELECT 1 FROM support.ticket_events LIMIT 1`.catch(() => {
  throw new Error('support.ticket_events is missing — apply migration 0001 before starting svc-support');
});

await sql`SELECT 1 FROM support.kb_articles LIMIT 1`.catch(() => {
  throw new Error('support.kb_articles is missing — apply migration 0003 before starting svc-support');
});

await sql`SELECT 1 FROM support.staff LIMIT 1`.catch(() => {
  throw new Error('support.staff is missing — apply migration 0012 before starting svc-support');
});

const store = new PostgresSupportStore(sql);
// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves the outgoing reads on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-support');
const s2sKey = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
// Account state is READ from svc-identity per request, never cached here.
const accounts = createAccountStateClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, s2sKey);
// Order status is READ from svc-trade per request. Unset TRADE_URL stays unknown.
const orders = env.TRADE_URL ? createTicketOrderClient(env.TRADE_URL, env.INTERNAL_SERVICE_SECRET, s2sKey) : new DarkTicketOrderSource();
// Third argument is the attachment desk and stays blank (attach refuses). Staff is fourth, orders fifth, then the blank-by-default staff heartbeat window.
const support = new SupportService(
  store,
  accounts,
  undefined,
  new SqlStaffBook(sql),
  orders,
  env.STAFF_HEARTBEAT_WINDOW_SECONDS ?? null,
  undefined,
  new SqlGroupBook(sql),
  env.SUPPORT_ALL_GROUPS_ROLES,
  new SqlPropertiesBook(sql),
  new SqlLifecycleBook(sql),
);
const loop = createTicketKbLoopObserver();
const appRouter = createSupportRouter(support, loop, env.INTERNAL_SERVICE_SECRET, support);
const edgeContext = createEdgeContext({
  secret: env.EDGE_PRINCIPAL_SECRET,
  ...edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
});

const app = await createSupportHttpApp({
  router: appRouter,
  edgeContext,
  serviceName: env.SERVICE_NAME,
  identitySecret: env.INTERNAL_SERVICE_SECRET,
  loop,
  logLevel: env.LOG_LEVEL,
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info({ port: env.HTTP_PORT }, 'svc-support ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
