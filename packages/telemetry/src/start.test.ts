import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trace, SpanStatusCode, diag } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTelemetry, isTelemetryActive } from './start.js';

/**
 * These tests exist because the bug this package fixes was INVISIBLE: eighteen
 * services wrote spans for months into a no-op tracer and every one of them
 * looked healthy. A test that asserts `startTelemetry()` returned an object
 * would have passed the whole time.
 *
 * So the assertion here is the only one worth making — a real OTLP payload
 * arrives on a real socket, carrying the `intafaced.money_path` attribute the
 * collector's tail sampler keys on. If this test can pass while Tempo stays
 * empty, it is the wrong test.
 */

/** One captured OTLP/HTTP export request body. */
const received: Array<{ path: string; body: string }> = [];

let collector: Server;
let endpoint: string;

beforeAll(async () => {
  collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

describe('startTelemetry', () => {
  it('registers nothing when OTEL_ENABLED is false, so spans stay no-op', () => {
    const handle = startTelemetry({ serviceName: 'svc-test', endpoint, enabled: false });
    expect(handle.enabled).toBe(false);
    expect(isTelemetryActive()).toBe(false);
  });

  it('delivers a money span to the collector over OTLP/HTTP', async () => {
    const handle = startTelemetry({
      serviceName: 'svc-ledger',
      endpoint,
      enabled: true,
      environment: 'test',
    });

    expect(handle.enabled).toBe(true);
    // The claim that matters: `trace.getTracer` no longer hands back a no-op.
    expect(isTelemetryActive()).toBe(true);

    const tracer = trace.getTracer('svc-ledger');
    await tracer.startActiveSpan('ledger.post', async (span) => {
      span.setAttribute('intafaced.money_path', true);
      span.setAttribute('intafaced.module', 'ledger');
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    });

    // A BatchSpanProcessor holds spans in memory; shutdown is what flushes
    // them. This is precisely why services must call it on SIGTERM.
    await handle.shutdown();

    expect(received.length).toBeGreaterThan(0);
    const exportRequest = received.find((r) => r.path.endsWith('/v1/traces'));
    expect(exportRequest, 'no export hit the collector').toBeDefined();

    const payload = exportRequest!.body;
    expect(payload).toContain('ledger.post');
    expect(payload).toContain('intafaced.money_path');
    expect(payload).toContain('svc-ledger');
  });

  it('shutdown is idempotent and never throws', async () => {
    const handle = startTelemetry({ serviceName: 'svc-test', endpoint, enabled: false });
    await expect(handle.shutdown()).resolves.toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('overlapping shutdowns await one in-flight flush', async () => {
    // The flush stays pending so a second caller cannot look settled while the
    // export is still running. A boolean early return does exactly that.
    let release: () => void = () => {};
    const flush = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proto = NodeTracerProvider.prototype;
    const original = proto.shutdown;
    let calls = 0;
    let instance: NodeTracerProvider | undefined;
    proto.shutdown = function (this: NodeTracerProvider) {
      calls += 1;
      instance = this;
      return flush;
    };

    try {
      const handle = startTelemetry({ serviceName: 'svc-test', endpoint, enabled: true });
      let firstSettled = false;
      let secondSettled = false;
      const first = handle.shutdown().then(() => {
        firstSettled = true;
      });
      const second = handle.shutdown().then(() => {
        secondSettled = true;
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      expect(calls).toBe(1);

      release();
      await Promise.all([first, second]);
      expect(firstSettled).toBe(true);
      expect(secondSettled).toBe(true);

      await handle.shutdown();
      expect(calls).toBe(1);
    } finally {
      release();
      proto.shutdown = original;
      if (instance) await original.call(instance);
    }
  });
});

/**
 * The failure channel has to exist in production, not only under `debug`.
 *
 * `diag` is a proxy: with no logger registered it does
 * `const logger = getGlobal('diag'); if (!logger) return;` — every call is a
 * silent no-op. `setLogger` used to run only under `options.debug`, and no
 * service passes it (checked: `startTelemetry({` appears in all eighteen
 * service entrypoints, `debug` in none). So a down collector, a DNS failure and
 * a full export queue were all invisible on every deployment — as was this
 * module's own `diag.warn('telemetry shutdown failed')`.
 *
 * That is the failure this package exists to end, one layer out: the provider
 * is real, but a broken EXPORT was as undetectable as the no-op tracer was.
 */
describe('the diag failure channel', () => {
  /**
   * A capturing logger, because the default one cannot be observed:
   * `DiagConsoleLogger` saves the original `console` methods at module load,
   * on purpose, so neither a spy nor a stream capture sees its output.
   */
  function capturing() {
    const lines: string[] = [];
    const record =
      (level: string) =>
      (message: string, ...args: unknown[]) =>
        void lines.push(`${level} ${message} ${args.map(String).join(' ')}`.trim());
    return {
      lines,
      logger: {
        error: record('error'),
        warn: record('warn'),
        info: record('info'),
        debug: record('debug'),
        verbose: record('verbose'),
      },
    };
  }

  it('carries a warning with telemetry enabled and debug OFF', async () => {
    // The whole finding: this used to be registered only under `debug`, and no
    // service passes it — so on all eighteen deployments a down collector, a
    // DNS failure and a full export queue were silent.
    const cap = capturing();
    const handle = startTelemetry({ serviceName: 'svc-test', endpoint, enabled: true, diagLogger: cap.logger });

    diag.warn('collector unreachable');
    diag.error('export failed');

    expect(cap.lines.join('\n')).toContain('collector unreachable');
    expect(cap.lines.join('\n')).toContain('export failed');
    await handle.shutdown();
  });

  it('stays quiet at debug level when debug is off', async () => {
    const cap = capturing();
    const handle = startTelemetry({ serviceName: 'svc-test', endpoint, enabled: true, diagLogger: cap.logger });

    diag.debug('per-span noise');

    // WARN by default: a real failure is heard, the per-span chatter is not.
    expect(cap.lines.join('\n')).not.toContain('per-span noise');
    await handle.shutdown();
  });

  it('registers no logger at all when telemetry is disabled', async () => {
    const cap = capturing();
    startTelemetry({ serviceName: 'svc-test', endpoint, enabled: false, diagLogger: cap.logger });

    diag.warn('should not be routed to this logger');

    expect(cap.lines.join('\n')).not.toContain('should not be routed to this logger');
  });
});

/**
 * A SIGTERM/SIGINT listener removes Node's default handler, which is what
 * exits the process. The hook must finish its flush and then exit or re-raise.
 * Otherwise `docker stop` waits out the grace period and SIGKILL cuts off the
 * flush this hook exists to save.
 */
describe('registerProcessHooks', () => {
  const startSource = fileURLToPath(new URL('./start.ts', import.meta.url));

  function signalHonored(sent: 'SIGTERM' | 'SIGINT', code: number | null, received: NodeJS.Signals | null): boolean {
    if (received === sent) return true;
    // 128 + signo. Exit 0 would be the signal swallowed as a clean success.
    return code === 128 + (sent === 'SIGTERM' ? 15 : 2);
  }

  async function onSignal(sent: 'SIGTERM' | 'SIGINT'): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    flushed: boolean;
    stderr: string;
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'l96-'));
    const marker = join(dir, 'flushed');
    const childPath = join(dir, 'child.mjs');
    writeFileSync(
      childPath,
      `import { registerProcessHooks } from ${JSON.stringify(startSource)};
import { writeFileSync } from 'node:fs';
registerProcessHooks({
  enabled: true,
  async shutdown() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(${JSON.stringify(marker)}, 'flushed');
  },
});
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`,
    );

    const child = spawn(process.execPath, [childPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => {});

    try {
      const ready = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        child.stdout!.on('data', () => {
          if (stdout.includes('ready')) {
            clearTimeout(timer);
            resolve(true);
          }
        });
        child.on('exit', () => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      if (!ready) {
        throw new Error(`hook child did not start\nstdout=${stdout}\nstderr=${stderr}`);
      }

      const pending = waitForExit(child, 800);
      child.kill(sent);
      const exit = await pending;
      if (exit.timedOut && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      return { ...exit, flushed: existsSync(marker), stderr };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Each signal is a fresh process. Importing the telemetry module dominates the time.
  it('flushes, then exits or re-raises SIGTERM and SIGINT', async () => {
    for (const sent of ['SIGTERM', 'SIGINT'] as const) {
      const outcome = await onSignal(sent);
      expect(outcome.flushed, `${sent} flush did not finish\n${outcome.stderr}`).toBe(true);
      expect(
        outcome.timedOut,
        `${sent} listener swallowed the signal; docker stop would wait until SIGKILL\n${outcome.stderr}`,
      ).toBe(false);
      expect(
        signalHonored(sent, outcome.code, outcome.signal),
        `${sent} swallowed: code=${outcome.code} signal=${outcome.signal}`,
      ).toBe(true);
    }
  }, 20_000);
});

function waitForExit(
  child: ChildProcess,
  ms: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}
