import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { readRelayEnvironment } from './env.js';
import { buildMailboxRelay } from './relay.js';
import { createRelayShutdown } from './shutdown.js';

// Optional independent entrypoint. No platform identity, events, telemetry,
// channels or NATS import is required to boot this private mailbox relay.
let sql: ReturnType<typeof postgres> | undefined;
let app: ReturnType<typeof buildMailboxRelay> | undefined;
try {
  const config = readRelayEnvironment(process.env);
  sql = postgres(config.databaseUrl, {
    max: 4,
    connect_timeout: 5,
    idle_timeout: 30,
    onnotice: () => undefined,
    connection: { application_name: 'notify-mailbox-relay', statement_timeout: 10000 },
  });
  // Provision the notify schema and its restricted owner before starting.
  // Only this independently owned, idempotent migration is applied here.
  await sql.unsafe(await readFile(new URL('../../drizzle/gateway/0000_mailbox_relay.sql', import.meta.url), 'utf8'));
  app = buildMailboxRelay({ sql, ...config });
  await app.listen({ host: config.host, port: config.port });
  console.info('notify.relay.listening');
  const shutdown = createRelayShutdown({
    closeHttp: async () => app?.close(),
    closeSql: async () => sql?.end({ timeout: 5 }),
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
} catch {
  // Error objects can contain connection URLs or HTTP credentials.
  console.error('notify.relay.startup_unavailable');
  await app?.close().catch(() => undefined);
  await sql?.end({ timeout: 5 }).catch(() => undefined);
  process.exitCode = 1;
}
