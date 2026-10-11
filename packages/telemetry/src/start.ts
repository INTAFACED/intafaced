import { diag, DiagConsoleLogger, DiagLogLevel, trace, type DiagLogger } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions';

/**
 * The thing that makes §9 tracing real.
 *
 * Every service in this repo already writes spans — `withMoneySpan` in each
 * `src/tracing.ts`, tagging `intafaced.money_path=true` so the collector's tail
 * sampler keeps money at 100% (tooling/infra/otel-collector.yaml). The
 * collector, Tempo, Grafana and `OTEL_EXPORTER_OTLP_ENDPOINT` were all already
 * wired. One piece was missing, and it is the piece that matters:
 *
 *   `@opentelemetry/api` on its own is a NO-OP.
 *
 * With no registered TracerProvider, `trace.getTracer()` hands back the no-op
 * tracer, `startActiveSpan` runs the callback, and the span is discarded before
 * it reaches a wire. Every span this platform has ever produced went nowhere.
 * That is not a degraded mode you can see on a dashboard — it looks exactly
 * like a healthy service that nothing has happened in yet. This module
 * registers the provider, so the spans already being written arrive in Tempo.
 *
 * ## Why a TracerProvider and not `NodeSDK` + auto-instrumentations
 *
 * `@opentelemetry/auto-instrumentations-node` patches Fastify / `postgres` /
 * NATS by intercepting CommonJS `require`. This repo is `"type": "module"`, and
 * in ESM those patches only apply when the process is started with the loader
 * hook (`--import @opentelemetry/instrumentation/hook.mjs`). Shipping the
 * auto-instrumentation packages without that flag would reproduce the exact
 * failure being fixed here: dependencies installed, wiring apparently present,
 * nothing emitted. Manual spans need no patching, and manual spans are where
 * the money is. Auto-instrumentation is a separate change that must land with
 * the loader flag and a test that proves a Fastify span exists.
 *
 * ## Failure posture
 *
 * Telemetry must never take down a money service. A collector that is down, a
 * DNS failure, a full export queue — all of it is the SDK's problem and is
 * reported through the diag channel, never thrown into a caller's request. The
 * one thing this module DOES insist on is flushing on shutdown: a batch
 * processor holds spans in memory, so a service that exits without flushing
 * loses its final batch — including, on a bad day, the last ledger post before
 * the crash you are trying to explain.
 */

export interface TelemetryOptions {
  /** Service name as it appears in Tempo. Pass `env.SERVICE_NAME`. */
  serviceName: string;
  /** Collector OTLP/HTTP base URL. Pass `env.OTEL_EXPORTER_OTLP_ENDPOINT`. */
  endpoint: string;
  /** Pass `env.OTEL_ENABLED`. When false, no provider is registered and spans stay no-op. */
  enabled: boolean;
  /** Deployment environment for the resource. Pass `env.APP_ENV`. */
  environment?: string;
  /** Optional service version for the resource. */
  version?: string;
  /** Emit SDK-internal diagnostics. Off unless something is being debugged. */
  debug?: boolean;
  /**
   * Where SDK diagnostics go. Defaults to the console.
   *
   * A seam, and it exists because the alternative is unprovable:
   * `DiagConsoleLogger` captures the original `console` methods at MODULE LOAD
   * — deliberately, "before any instrumentation can wrap them" — so no spy and
   * no stream capture can ever observe what it writes. The promise that a down
   * collector "is reported through the diag channel" was therefore untestable,
   * and it was also false. One of those is worth fixing without the other.
   */
  diagLogger?: DiagLogger;
}

export interface TelemetryHandle {
  /** True when a real provider was registered — false under `OTEL_ENABLED=false`. */
  readonly enabled: boolean;
  /** Flush pending spans and stop. Safe to call more than once. */
  shutdown(): Promise<void>;
}

const NOOP: TelemetryHandle = { enabled: false, async shutdown() {} };

/**
 * Register the global TracerProvider. Call this ONCE per process, before the
 * first span is created — that means before service construction, not after
 * the HTTP server is listening.
 *
 * Returns a handle whose `shutdown()` flushes. `registerProcessHooks` wires it
 * to SIGTERM/SIGINT for you.
 */
export function startTelemetry(options: TelemetryOptions): TelemetryHandle {
  if (!options.enabled) return NOOP;

  /**
   * REGISTER THE FAILURE CHANNEL UNCONDITIONALLY.
   *
   * The docstring above promises that a down collector, a DNS failure or a full
   * export queue "is reported through the diag channel". It was not. `diag` is
   * a proxy: with no logger registered, `_logProxy` does
   * `const logger = getGlobal('diag'); if (!logger) return;` — every call is a
   * silent no-op. And this line used to run only under `options.debug`, which
   * NO service passes. Checked, not assumed: `startTelemetry({` appears in all
   * eighteen service entrypoints and `debug` in none of them.
   *
   * So on every deployment, every export failure was invisible — including this
   * module's own `diag.warn('telemetry shutdown failed')` below, which called a
   * channel that could not carry it.
   *
   * That is the same failure this package was written to end. Its test file
   * opens with it: eighteen services wrote spans into a no-op tracer and every
   * one of them looked healthy. The provider is real now; a broken EXPORT was
   * still as undetectable as the no-op tracer had been.
   *
   * WARN by default so a real failure is heard, INFO under `debug` for the
   * per-span noise nobody wants in production.
   */
  diag.setLogger(options.diagLogger ?? new DiagConsoleLogger(), options.debug ? DiagLogLevel.INFO : DiagLogLevel.WARN);

  const exporter = new OTLPTraceExporter({
    // The collector's OTLP/HTTP receiver listens on 4318 and expects the signal
    // path. `OTEL_EXPORTER_OTLP_ENDPOINT` is the BASE, per the OTLP spec, so
    // the path is appended here rather than baked into every service's env.
    url: `${options.endpoint.replace(/\/+$/, '')}/v1/traces`,
  });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      ...(options.version ? { [ATTR_SERVICE_VERSION]: options.version } : {}),
      ...(options.environment ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment } : {}),
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  provider.register();

  // One shared flush. A later caller, including one that arrives while
  // provider.shutdown() is still in flight, awaits that same promise. A
  // boolean set before the await lets the second caller return while the
  // export is still running.
  let shutdownPromise: Promise<void> | undefined;
  return {
    enabled: true,
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      // Never let a failing flush change the process's exit path. The service
      // is already on its way down; a collector that will not answer is not a
      // reason to turn a clean shutdown into a crash.
      shutdownPromise = (async () => {
        try {
          await provider.shutdown();
        } catch (err) {
          diag.warn('telemetry shutdown failed', err);
        }
      })();
      return shutdownPromise;
    },
  };
}

/**
 * Flush on the signals a container actually receives. Without this, `docker
 * stop` costs you the last batch — which is the batch you want.
 */
export function registerProcessHooks(handle: TelemetryHandle): void {
  if (!handle.enabled) return;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void handle.shutdown();
    });
  }
}

/**
 * True when spans created right now would actually be recorded.
 *
 * Deliberately a BEHAVIOURAL probe rather than a class-name check: with no
 * provider registered the API hands back a `ProxyTracer`, not a `NoopTracer`,
 * so inspecting the constructor reports "active" in exactly the broken state
 * this package exists to detect. Asking the span whether it is recording is the
 * same question the exporter asks.
 */
export function isTelemetryActive(): boolean {
  const probe = trace.getTracer('intafaced.telemetry.probe').startSpan('probe');
  // Never ended on purpose: a span is only queued for export on `end()`, so
  // this costs one object and pollutes no trace.
  return probe.isRecording();
}
