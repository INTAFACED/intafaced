#!/usr/bin/env node
/**
 * Create every JetStream stream the event catalog declares, empty and idempotent, with the bus's own `ensureStream`,
 * then exit. Services subscribe to streams other services own (svc-identity consumes `blueprintCreated` on the
 * `blueprint` stream), and a subscribe to a stream whose owner has not started yet fails with "stream not found" and
 * stops the process. An owner may never start at all: svc-blueprint refuses to boot while BLUEPRINT_ENGINE_URL is blank.
 * So streams are infrastructure, made before any service, like the schemas tooling/infra/migrate-all.mjs makes.
 *
 * Run by the `nats-streams` compose job (every service on the bus waits for it, docker-compose.apps.yml `x-needs-bus`)
 * and by `pnpm local:stack` (tooling/scripts/local-test-stack.mjs). Needs packages/events built.
 *
 *   NATS_URL=nats://… [NATS_STREAM_PREFIX=INTAFACED] node tooling/infra/ensure-streams.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EVENTS = path.join(ROOT, 'packages', 'events');

const url = process.env.NATS_URL;
if (!url) {
  console.error('ensure-streams: NATS_URL is unset');
  process.exit(2);
}
// `nats` is packages/events' dependency, not the root's, so it resolves from there.
const { connect } = createRequire(path.join(EVENTS, 'package.json'))('nats');
const { EVENT_CATALOG, ensureStream } = await import(pathToFileURL(path.join(EVENTS, 'dist', 'index.js')).href);

const modules = [...new Set(Object.values(EVENT_CATALOG).map((d) => d.service))].sort();
if (modules.length === 0) {
  console.error('ensure-streams: the event catalog declares no streams; nothing was made');
  process.exit(1);
}
const nc = await connect({ servers: url });
try {
  const jsm = await nc.jetstreamManager();
  for (const m of modules) await ensureStream(jsm, m, process.env.NATS_STREAM_PREFIX || undefined);
} finally {
  await nc.close();
}
console.log(modules.join(','));
