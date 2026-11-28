/**
 * Test support: boots the real entrypoint (`src/index.ts`) inside the test process, so a test asks the booted
 * service what it wired instead of reading the file. Nothing listens on a port (`listen` is recorded, then a no-op;
 * the routes are asked through `app.inject`), telemetry and process hooks are off, and the signal handlers the
 * entrypoint installs are kept for the test and removed again on `close`. The router factory is the real one; the
 * harness only keeps the arguments the entrypoint handed it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';

/** The secret the booted service verifies the edge principal with. Fixture only. */
/** The edge secret every boot gets unless a test sets its own. Fixture only. */
export const BOOT_EDGE_SECRET = 'svc-execution-boot-placeholder-edge-secret-long';

type Signal = 'SIGTERM' | 'SIGINT';
const SIGNALS: readonly Signal[] = ['SIGTERM', 'SIGINT'];

export interface BootedExecution {
  /** The Fastify instance the entrypoint built and registered every door on. */
  readonly app: FastifyInstance;
  /** The arguments the entrypoint passed to `createExecutionRouter`, in order. */
  readonly routerArgs: readonly unknown[];
  /** How many timers the boot started with `setInterval` (a job ticker or a drain loop would be one). */
  readonly intervalsStarted: number;
  /** What the entrypoint asked `listen` for. */
  readonly listenArgs: unknown;
  /** The handlers the entrypoint added for each shutdown signal. */
  readonly signalHandlers: Readonly<Record<Signal, ReadonlyArray<(...args: unknown[]) => void>>>;
  /** The EMS journal path the boot used (`EXECUTION_EMS_STORE_PATH`). */
  readonly emsStorePath: string;
  /** Closes the app, removes the signal handlers and the temp folder, and restores the environment. */
  readonly close: () => Promise<void>;
}

/**
 * The service's own `env` (from `src/env.ts`), loaded fresh from `vars` on top of a fixture edge secret. A variable
 * given as `undefined` is unset for the load. A load that refuses rethrows its error.
 */
export async function loadExecutionEnv(vars: Record<string, string | undefined> = {}): Promise<import('../env.js').ExecutionEnv> {
  vi.resetModules();
  vi.stubEnv('EDGE_PRINCIPAL_SECRET', BOOT_EDGE_SECRET);
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  try {
    return (await import('../env.js')).env;
  } finally {
    vi.unstubAllEnvs();
  }
}

/**
 * Boot `src/index.ts` with `vars` as its environment, on top of a fixture edge secret and a temp EMS journal (a
 * `vars` entry wins, so `EXECUTION_EMS_STORE_PATH: ''` boots with a blank path). A boot that throws leaves nothing
 * behind and rethrows.
 */
export async function bootExecution(vars: Record<string, string> = {}): Promise<BootedExecution> {
  const dir = mkdtempSync(join(tmpdir(), 'execution-boot-'));
  const defaults = {
    EDGE_PRINCIPAL_SECRET: BOOT_EDGE_SECRET,
    EXECUTION_EMS_STORE_PATH: join(dir, 'ems-journal.jsonl'),
    OTEL_ENABLED: 'false',
    LOG_LEVEL: 'fatal',
  };
  const environment = { ...defaults, ...vars };
  vi.resetModules();
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);

  let app: FastifyInstance | undefined;
  let routerArgs: unknown[] = [];
  let listenArgs: unknown;
  vi.doMock('fastify', async (importOriginal) => {
    const real = await importOriginal<typeof import('fastify')>();
    const make = ((opts?: Parameters<typeof real.default>[0]) => {
      const built = real.default(opts);
      built.listen = (async (args: unknown) => {
        listenArgs = args;
        return '';
      }) as FastifyInstance['listen'];
      app = built;
      return built;
    }) as typeof real.default;
    return { ...real, default: make };
  });
  vi.doMock('@intafaced/telemetry', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@intafaced/telemetry')>()),
    registerProcessHooks: () => undefined,
    startTelemetry: () => ({ shutdown: async () => undefined }),
  }));
  vi.doMock('../router.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../router.js')>();
    return {
      ...real,
      createExecutionRouter: (...args: Parameters<typeof real.createExecutionRouter>) => {
        routerArgs = args;
        return real.createExecutionRouter(...args);
      },
    };
  });

  const before = new Map(SIGNALS.map((s) => [s, new Set(process.listeners(s))]));
  const added = (s: Signal) => process.listeners(s).filter((l) => !before.get(s)?.has(l)) as Array<(...args: unknown[]) => void>;
  const cleanUp = async () => {
    for (const s of SIGNALS) for (const l of added(s)) process.removeListener(s, l);
    await app?.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  };
  const intervalSpy = vi.spyOn(globalThis, 'setInterval');
  let intervalsStarted = 0;
  try {
    await import('../index.js');
    intervalsStarted = intervalSpy.mock.calls.length;
    if (!app) throw new Error('the entrypoint built no Fastify app');
    await app.ready();
  } catch (err) {
    await cleanUp();
    throw err;
  } finally {
    intervalSpy.mockRestore();
    vi.doUnmock('fastify');
    vi.doUnmock('@intafaced/telemetry');
    vi.doUnmock('../router.js');
  }

  return {
    app,
    routerArgs,
    listenArgs,
    intervalsStarted,
    signalHandlers: { SIGTERM: added('SIGTERM'), SIGINT: added('SIGINT') },
    emsStorePath: environment.EXECUTION_EMS_STORE_PATH,
    close: cleanUp,
  };
}
