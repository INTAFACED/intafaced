import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { trace, SpanStatusCode, diag } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTelemetry, isTelemetryActive, registerProcessHooks } from './start.js';

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

  it('shares a rejected provider flush and reports the failure without rejecting callers', async () => {
    const original = NodeTracerProvider.prototype.shutdown;
    let provider: NodeTracerProvider | undefined;
    let calls = 0;
    const warnings: unknown[][] = [];
    NodeTracerProvider.prototype.shutdown = function () {
      provider = this;
      calls += 1;
      return Promise.reject(new Error('collector unavailable'));
    };
    try {
      const quiet = () => {};
      const handle = startTelemetry({
        serviceName: 'svc-test',
        endpoint,
        enabled: true,
        diagLogger: {
          error: quiet,
          warn: (...args) => {
            warnings.push(args);
          },
          info: quiet,
          debug: quiet,
          verbose: quiet,
        },
      });
      const first = handle.shutdown();
      const second = handle.shutdown();
      expect(second).toBe(first);
      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBeUndefined();
      expect(handle.shutdown()).toBe(first);
      expect(calls).toBe(1);
      expect(warnings.filter((args) => args[0] === 'telemetry shutdown failed')).toHaveLength(1);
    } finally {
      NodeTracerProvider.prototype.shutdown = original;
      if (provider) await original.call(provider);
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

describe('service-owned signal drains', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'allows a slower service drain to finish after %s',
    async (signal) => {
      // The child is a bare `node` process, and Node 20 (CI) cannot import `.ts`,
      // so it loads the compiled module. `pnpm test` builds `dist` first.
      const source = fileURLToPath(new URL('../dist/start.js', import.meta.url));
      const script = `
      import { registerProcessHooks } from ${JSON.stringify(source)};
      registerProcessHooks({ enabled: true, async shutdown() {
        await new Promise(resolve => setTimeout(resolve, 20));
        process.stdout.write('flushed\\n');
      }});
      process.once(${JSON.stringify(signal)}, () => {
        void (async () => {
          await new Promise(resolve => setTimeout(resolve, 120));
          process.stdout.write('drained\\n');
          process.exit(0);
        })();
      });
      setInterval(() => {}, 1000);
      process.stdout.write('ready\\n');
    `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let sent = false;
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 5000);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
          if (!sent && stdout.includes('ready')) {
            sent = true;
            child.kill(signal);
          }
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.once('exit', (code, received) => {
          clearTimeout(timer);
          resolve({ code, signal: received, timedOut: received === 'SIGKILL' });
        });
      });
      expect(outcome, stderr).toEqual({ code: 0, signal: null, timedOut: false });
      expect(stdout, stderr).toContain('flushed');
      expect(stdout, stderr).toContain('drained');
    },
    10_000,
  );

  it('adds no process listeners when telemetry is disabled', () => {
    const before = ['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal));
    registerProcessHooks({ enabled: false, shutdown: async () => {} });
    expect(['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal))).toEqual(before);
  });
});
