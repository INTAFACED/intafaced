import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMETHEUS_CONTENT_TYPE, REQUESTS_TOTAL, REQUEST_DURATION_SECONDS, parseExposition } from '@intafaced/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * THE SHIPPED ENTRYPOINT, BOOTED, AND SCRAPED OVER A REAL SOCKET.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS, AND IT IS THE WHOLE POINT OF THE CHANGE
 *
 * `metrics.test.ts` builds a Fastify instance, calls `registerMetrics` on it and
 * asserts the endpoint answers. That proves the FUNCTION works. It does not
 * prove that `index.ts` — the file that actually runs in the container — ever
 * calls it. Delete the `registerMetrics(app, …)` line from `index.ts` and every
 * other test in this service still passes, while the deployed service serves 404
 * on `/metrics` and Prometheus reports the target DOWN.
 *
 * That is not a hypothetical. This repo has shipped seven guards that were
 * correct in isolation and unreachable in place, each carrying a comment
 * asserting the property the code lacked. `control-plane.e2e.test.ts` names the
 * limitation directly: "The one thing this cannot cover is the proxy handler in
 * `index.ts`, which reads env and listens at module scope." Until this file, no
 * test in this service had ever executed `index.ts` at all.
 *
 * So this boots it. A real child process, the real module-scope `env` parse, the
 * real `app.listen()`, a real TCP connection, and an assertion on the parsed
 * body. It is the difference between the tracker row being `ready` and `done`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS AND IS NOT STUBBED
 *
 * Nothing is stubbed. The upstreams are simply absent, which is why the proxied
 * request below is expected to come back 502 — and that is the more valuable
 * assertion anyway: it proves a FAILED request lands in the histogram, so the
 * denominator of the availability panel contains the outages. An SLO computed
 * only over requests that succeeded is 100% by construction.
 *
 * Secrets here are test-only literals for a process that binds loopback, holds
 * no database and reaches no network. `env.ts` deliberately withholds
 * `DATABASE_URL`, `NATS_URL` and `INTERNAL_SERVICE_SECRET` from this service, so
 * there is nothing else to provide.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');

/** Ask the OS for a port nobody is using, then hand it to the child. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | null = null;
let base = '';

/** Poll until the process is listening, or give up loudly. */
async function waitForBoot(url: string, log: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`svc-edge exited with ${child.exitCode} before listening:\n${log()}`);
    }
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`svc-edge never became reachable (${last}):\n${log()}`);
}

/**
 * A port from `freePort` is free only until the probe closes; another process on
 * the runner can take it before the child binds it (EADDRINUSE). Only that
 * exit boots again on a fresh port; any other exit still fails the run.
 */
const isAddressInUse = (output: string): boolean => /\bEADDRINUSE\b/.test(output);

beforeAll(async () => {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;

    let output = '';
    const log = () => output;

    // `--import tsx` keeps this to ONE process, so the kill in `afterAll` cannot
    // leave an orphan holding the port. `tsx src/index.ts` would spawn a grandchild
    // that survives killing its parent on Windows.
    child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
      cwd: join(HERE, '..'),
      env: {
        ...process.env,
        APP_ENV: 'test',
        NODE_ENV: 'test',
        SERVICE_NAME: 'svc-edge',
        HTTP_HOST: '127.0.0.1',
        HTTP_PORT: String(port),
        LOG_LEVEL: 'fatal',
        // No collector in a unit-test run; a provider that cannot export would
        // only add retry noise to this process's stderr.
        OTEL_ENABLED: 'false',
        JWT_ACCESS_SECRET: 'test-only-signing-secret-at-least-32-characters-long',
        EDGE_PRINCIPAL_SECRET: 'test-only-edge-principal-secret-at-least-32-chars',
        EDGE_RATE_LIMIT_MAX: '300',
        EDGE_RATE_LIMIT_WINDOW_MS: '60000',
        EDGE_BODY_LIMIT_BYTES: '1048576',
        // Listed fixture so the geo-block guard can pass through to the proxy
        // (unset would 503 as unknown). Placeholder codes only — not counsel content.
        INTAFACED_SANCTIONS_REGIONS: 'AA:test-fixture-not-a-real-list',
        // Kept out of the repo tree so a test run cannot leave a state file behind.
        EDGE_KILL_STATE_PATH: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      output += d.toString();
    });

    try {
      await waitForBoot(base, log);
      return;
    } catch (err) {
      if (attempt >= 5 || child?.exitCode === null || !isAddressInUse(output)) throw err;
      child = null;
    }
  }
}, 90_000);

afterAll(async () => {
  child?.kill();
  child = null;
});

describe('the deployed svc-edge serves /metrics', () => {
  it('answers 200 with the Prometheus content type from the real process', async () => {
    const res = await fetch(`${base}/metrics`);

    // A 404 here means `index.ts` does not call `registerMetrics`. Every other
    // test in this service would still be green.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
  });

  it('emits both metric families through the real module-scope wiring', async () => {
    const parsed = parseExposition(await (await fetch(`${base}/metrics`)).text());

    expect(parsed.type[REQUESTS_TOTAL]).toBe('counter');
    expect(parsed.type[REQUEST_DURATION_SECONDS]).toBe('histogram');
  });

  it('labels its samples with the SERVICE_NAME the process was given', async () => {
    // Drive one local request so there is a sample to look at.
    await fetch(`${base}/ready`);

    const parsed = parseExposition(await (await fetch(`${base}/metrics`)).text());
    const samples = parsed.samples.filter((s) => s.name === REQUESTS_TOTAL);

    expect(samples.length).toBeGreaterThan(0);
    // Proves the `service` label is wired from env rather than hardcoded, which
    // is what lets a second service adopt the package and appear as its own
    // series on the same panel.
    expect(samples.every((s) => s.labels.service === 'svc-edge')).toBe(true);
  });
});

/**
 * Unauthenticated `/ready` must not be a kill-switch oracle.
 *
 * CORS preflight is ordered so an unauthenticated caller cannot learn which
 * modules an operator halted. Publishing `disabledModules` on `/ready` undid
 * that (audit 2026-08-08 #5). The operator surface is `/admin/status`.
 */
describe('the deployed /ready does not leak the halt list', () => {
  it('answers ready with routes/screening/cors and without disabledModules', async () => {
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ready).toBe(true);
    expect(Array.isArray(body.routes)).toBe(true);
    expect(body.screening).toBeTypeOf('object');
    expect(body.cors).toBeTypeOf('object');
    expect(body.bodyLimitBytes).toBeTypeOf('number');
    expect(Object.prototype.hasOwnProperty.call(body, 'disabledModules')).toBe(false);
  });

  it('still returns 502 with edge.upstream_unavailable when an upstream is absent', async () => {
    // Proves the proxy path in index.ts is wired: dead upstream → 502, not 500.
    const res = await fetch(`${base}/api/trade/trpc/orders.list`, { method: 'GET' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('edge.upstream_unavailable');
  });

  it('returns 404 edge.no_route for an unlisted prefix', async () => {
    const res = await fetch(`${base}/api/ledger/trpc/post`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('edge.no_route');
  });

  it('counts a failed proxy attempt — the outage goes in the denominator', async () => {
    // No svc-trade is running, so the edge answers 502. That is the point.
    const proxied = await fetch(`${base}/api/trade/markets`);
    expect(proxied.status).toBe(502);

    const parsed = parseExposition(await (await fetch(`${base}/metrics`)).text());
    const trade = parsed.samples.find((s) => s.name === REQUESTS_TOTAL && s.labels.module === 'trade');

    expect(trade).toBeDefined();
    expect(trade?.labels.status).toBe('5xx');
    // `anonymous` comes from the `markAuthOutcome` call inside the proxy handler
    // in `index.ts` — a code path no other test in this service reaches.
    expect(trade?.labels.outcome).toBe('anonymous');

    const count = parsed.samples.find((s) => s.name === `${REQUEST_DURATION_SECONDS}_count` && s.labels.module === 'trade');
    expect(count?.value).toBeGreaterThanOrEqual(1);
  });

  it('does not expose a module label for a path it never routed', async () => {
    await fetch(`${base}/api/definitely-not-a-module/x`);

    const parsed = parseExposition(await (await fetch(`${base}/metrics`)).text());
    const modules = new Set(parsed.samples.map((s) => s.labels.module));

    // Bounded label set, proven against the live process rather than the unit.
    expect(modules).toContain('_unrouted');
    for (const m of modules) {
      expect(m).not.toContain('definitely-not-a-module');
    }
  });
});
