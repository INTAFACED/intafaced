// Records, from the TypeScript svc-ledger in this checkout, what the Rust `GET /metrics` is held to:
// `tests/fixtures/metrics-route.golden.json`.
//
// - `scrapes`: `registerMetrics(app, { service, gauges })` (services/svc-ledger/src/metrics.ts) on a fresh Fastify app,
//   with `reconcileGauges` over recorded `lastVerified` answers, a gauge read that throws, and no gauges at all: each
//   first scrape's status, content type and body, byte for byte.
// - `requests`: the requests `metrics.test.ts`' app answers (`/health`, a handler that throws, and paths it does not
//   serve), then two scrapes; the second one's lines that do not depend on time (the counter, `_count` and the
//   `+Inf` bucket).
//
// Run from the repository root:
//   node --import tsx crates/svc-ledger/scripts/record-metrics.mjs          writes the file
//   node --import tsx crates/svc-ledger/scripts/record-metrics.mjs --check  fails when it is stale
//
// It reads the TypeScript service and never writes there. It stops being runnable when the TypeScript service is
// deleted, and from then on what it wrote is the reference (the kit's exposition is held to `@intafaced/telemetry` by
// `crates/service-kit/scripts/record-metrics.mjs`, which stays runnable).

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire as requireFrom } from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const prettier = requireFrom(`${ROOT}package.json`)('prettier');
const OUT = fileURLToPath(new URL('../tests/fixtures/metrics-route.golden.json', import.meta.url));
const require = createRequire(`${ROOT}services/svc-ledger/package.json`);
const Fastify = require('fastify');
const { registerMetrics, reconcileGauges } = await import(pathToFileURL(`${ROOT}services/svc-ledger/src/metrics.ts`).href);

const last = (at, seq) => ({ at: at === null ? null : new Date(at), seq });
const scrapeCases = [
  { name: 'never proved', service: 'svc-ledger', last: last(null, null) },
  { name: 'proved', service: 'svc-ledger', last: last(1700000000999, '42') },
  { name: 'proved on a whole second', service: 'svc-ledger', last: last(1700000000000, '1') },
  { name: 'proved before the epoch', service: 'svc-ledger', last: last(-1500, '123456789012345678901234567890') },
  { name: 'a service name with a quote, a backslash and a line feed', service: 'svc-"led\\ger\n', last: last(1700000000999, '7') },
  { name: 'a gauge read that throws', service: 'svc-ledger', last: 'throws' },
  { name: 'no gauges', service: 'svc-ledger', last: 'none' },
];

async function scrape(c) {
  const app = Fastify({ logger: false });
  const gauges =
    c.last === 'none'
      ? undefined
      : async () => {
          if (c.last === 'throws') throw new Error('reconcile_runs unreadable');
          return reconcileGauges(c.last);
        };
  registerMetrics(app, { service: c.service, ...(gauges ? { gauges } : {}) });
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  await app.close();
  return {
    name: c.name,
    service: c.service,
    last: typeof c.last === 'string' ? c.last : { atMs: c.last.at === null ? null : c.last.at.getTime(), seq: c.last.seq },
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  };
}

const REQUESTS = [
  ['GET', '/health'],
  ['GET', '/health?owner=alice&cursor=abc'],
  ['HEAD', '/health'],
  ['GET', '/boom'],
  ['GET', '/boom'],
  ['POST', '/trpc/post'],
  ['GET', '/operator/freeze'],
  ['DELETE', '/nowhere'],
  ['OPTIONS', '/health'],
  ['PUT', '/health/'],
  ['GET', '/metrics'],
];

async function requests() {
  const app = Fastify({ logger: false });
  registerMetrics(app, { service: 'svc-ledger' });
  app.get('/health', async () => ({ ok: true }));
  app.get('/boom', async () => {
    throw new Error('handler exploded');
  });
  await app.ready();
  const answered = [];
  for (const [method, url] of REQUESTS) {
    const res = await app.inject({ method, url });
    answered.push({ method, url, status: res.statusCode });
  }
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  await app.close();
  const timeless = res.body
    .split('\n')
    .filter(
      (l) => l !== '' && (!l.startsWith('intafaced_http_request_duration_seconds_') || l.includes('_count{') || l.includes('le="+Inf"')),
    );
  return { requests: answered, lines: timeless };
}

const golden = { scrapes: [], requests: await requests() };
for (const c of scrapeCases) golden.scrapes.push(await scrape(c));

// Written as the repository's formatter writes JSON, so the commit hook's format check and `--check` agree.
const text = await prettier.format(JSON.stringify(golden), { ...(await prettier.resolveConfig(OUT)), filepath: OUT });
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {}
  if (current !== text) {
    console.error(`stale: ${OUT}; run without --check`);
    process.exit(1);
  }
  console.log('metrics-route.golden.json is current');
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
