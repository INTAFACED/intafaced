import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INDEX.TS ACTUALLY CALLS registerMetrics.
 *
 * `metrics.test.ts` builds a Fastify instance, calls `registerMetrics` on it
 * and asserts the endpoint answers. That proves the FUNCTION works. It does
 * not prove that `index.ts` — the file that actually runs in the container —
 * ever calls it. Delete the `registerMetrics(app, …)` line from `index.ts` and
 * every other inject test in this service still passes, while the deployed
 * service serves 404 on `/metrics` and Prometheus reports the target DOWN.
 *
 * Edge proves the same property by spawning `index.ts`. Ledger cannot: the
 * entrypoint connects Postgres (`postgres(env.DATABASE_URL)`) and JetStream
 * (`JetStreamEventBus.connect`) at module scope before it constructs Fastify,
 * and there is no env that skips that. A skipIf postgres/nats-reachable boot
 * would be green in CI on a ledger shard that has no postgres or nats
 * container — which is the same as no test.
 *
 * So this file reads THE REAL `index.ts` and fails if the call is missing,
 * commented out, or moved after `app.listen`. Combined with the inject suite
 * (the payload) and `observability-wiring.test.ts` (the scrape job), that is
 * the property: a deleted call is a red test, not a silent 404 in prod.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.ts');

function indexSource(): string {
  return readFileSync(INDEX, 'utf8');
}

/** Executable lines — not `//` or block-comment `*` prefixes. */
function liveLines(src: string): { line: string; index: number }[] {
  let offset = 0;
  const out: { line: string; index: number }[] = [];
  for (const line of src.split(/\r?\n/)) {
    const t = line.trimStart();
    if (!(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))) {
      out.push({ line, index: offset });
    }
    offset += line.length + 1;
  }
  return out;
}

describe('the deployed svc-ledger entrypoint wires /metrics', () => {
  it('imports registerMetrics from ./metrics.js — not a local no-op', () => {
    const src = indexSource();
    const live = liveLines(src)
      .map((l) => l.line)
      .join('\n');
    expect(live).toMatch(/import\s*\{[^}]*\bregisterMetrics\b[^}]*\}\s*from\s*['"]\.\/metrics\.js['"]/);
  });

  it('calls registerMetrics(app, { service: env.SERVICE_NAME }) before listen', () => {
    const src = indexSource();
    const live = liveLines(src);
    const call = live.find((l) =>
      /registerMetrics\(\s*app\s*,\s*\{\s*service:\s*env\.SERVICE_NAME\s*(?:,\s*gauges:[^}]*)?\}\s*\)/.test(l.line),
    );
    expect(call, 'index.ts must call registerMetrics(app, { service: env.SERVICE_NAME }) on a live line').toBeDefined();

    const listen = live.find((l) => /app\.listen\s*\(/.test(l.line));
    expect(listen).toBeDefined();
    expect(call!.index).toBeLessThan(listen!.index);
  });

  it('fails if the call is commented out', () => {
    const src = indexSource();
    const calls = liveLines(src).filter((l) => /registerMetrics\(\s*app/.test(l.line));
    expect(calls.length).toBeGreaterThan(0);
  });
});
