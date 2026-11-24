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
 * A JetStream API call that times out, finds no responder or loses its connection is tried again, from a new
 * connection, until RETRY_FOR_MS has passed: on a busy machine one call can miss the client's 5 s wait while the server
 * is healthy (#10660: a journey's restart of one service failed on it). Any other error, or the same error past the
 * deadline, stops at once, its code on the first line.
 *
 *   NATS_URL=nats://… [NATS_STREAM_PREFIX=INTAFACED] node tooling/infra/ensure-streams.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EVENTS = path.join(ROOT, 'packages', 'events');

/** The nats client's codes for a call that got no answer in time or lost its way, not one the server refused. */
export const TRANSIENT = new Set(['TIMEOUT', '503', '408', 'CONNECTION_REFUSED', 'CONNECTION_CLOSED', 'CONNECTION_TIMEOUT', 'DISCONNECT']);
export const RETRY_FOR_MS = 30_000;
const PAUSE_MS = 1_000;

/**
 * Make every module's stream, trying again from a new connection on a transient error until `retryForMs` has passed.
 * Returns how many tries it took; throws the last error otherwise.
 */
export async function ensureAll({
  modules,
  connect,
  ensure,
  retryForMs = RETRY_FOR_MS,
  now = Date.now,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const until = now() + retryForMs;
  for (let tries = 1; ; tries++) {
    try {
      const nc = await connect();
      try {
        const jsm = await nc.jetstreamManager();
        for (const m of modules) await ensure(jsm, m);
      } finally {
        await nc.close().catch(() => {});
      }
      return tries;
    } catch (err) {
      if (!TRANSIENT.has(String(err?.code)) || now() >= until) throw err;
      console.error(`ensure-streams: try ${tries} failed (${err.code}: ${err.message}); trying again`);
      await pause(PAUSE_MS);
    }
  }
}

async function main() {
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
  const prefix = process.env.NATS_STREAM_PREFIX || undefined;
  try {
    await ensureAll({ modules, connect: () => connect({ servers: url }), ensure: (jsm, m) => ensureStream(jsm, m, prefix) });
  } catch (err) {
    console.error(`ensure-streams: ${err?.code ?? 'error'}: ${err?.message ?? err}`);
    process.exit(1);
  }
  console.log(modules.join(','));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
