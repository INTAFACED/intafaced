/**
 * Test support: boots the real entrypoint (`src/index.ts`) inside the test process, so a test asks the booted
 * service what it wired instead of reading the file.
 *
 * What is stood in, and only that: the database (`createDb` answers the boot's table probe and records `close`),
 * the network (every `fetch`, so every RPC call, fails as unreachable), `listen` (recorded, no port opens),
 * telemetry and process hooks (off), and `process.exit` (recorded). Every module of the service itself is the real
 * one; the harness keeps the deps the entrypoint handed `registerIndexerPublicHttp`.
 *
 * `close` shuts the service down the way the container does, by raising SIGTERM through the handler the entrypoint
 * installed, then removes what the boot left behind.
 */
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import type { IndexerPublicHttpDeps } from '../public-http.js';

/** The secret the booted service verifies the edge principal with. Fixture only. */
/** The edge secret every boot gets unless a test sets its own. Fixture only. */
export const BOOT_EDGE_SECRET = 'svc-indexer-boot-placeholder-edge-secret-long';

/** A complete operator environment for a boot. Fixture values only. */
export const BOOT_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/intafaced_indexer_test',
  DATABASE_POOL_MAX: '2',
  EDGE_PRINCIPAL_SECRET: BOOT_EDGE_SECRET,
  INDEXER_CHAIN_ID: '1',
  INDEXER_RPC_URL: 'http://rpc.test:8545',
  INDEXER_VENUE_ADDRESS: '0x1111111111111111111111111111111111111111',
  INDEXER_START_HEIGHT: '0',
  INDEXER_FINALITY_DEPTH: '64',
  INDEXER_BATCH_SIZE: '50',
  INDEXER_POLL_INTERVAL_MS: '600000',
  OTEL_ENABLED: 'false',
  LOG_LEVEL: 'fatal',
};

type Signal = 'SIGTERM' | 'SIGINT';
const SIGNALS: readonly Signal[] = ['SIGTERM', 'SIGINT'];

export interface BootedIndexer {
  readonly app: FastifyInstance;
  /** What the entrypoint handed `registerIndexerPublicHttp`. */
  readonly publicHttp: IndexerPublicHttpDeps;
  /** What the entrypoint asked `listen` for. */
  readonly listenArgs: unknown;
  /** The handlers the entrypoint added for each shutdown signal. */
  readonly signalHandlers: Readonly<Record<Signal, ReadonlyArray<() => void>>>;
  /** How many times the database was closed, and the exit codes asked for, so far. */
  readonly record: { dbCloses: number; exits: number[]; order: string[] };
  /** Raise a shutdown signal through the entrypoint's own handler (process.exit is recorded, not run). */
  readonly raise: (signal: Signal) => void;
  /** Resolves once the entrypoint has asked to exit `count` times. */
  readonly exited: (count?: number) => Promise<void>;
  /** Shuts down through SIGTERM (unless already exited) and removes what the boot left behind. */
  readonly close: () => Promise<void>;
}

/** Boot `src/index.ts` with BOOT_ENV and `vars` (a `vars` entry wins; `undefined` unsets). A boot that throws rethrows. */
export async function bootIndexer(vars: Record<string, string | undefined> = {}): Promise<BootedIndexer> {
  vi.resetModules();
  for (const [name, value] of Object.entries({ ...BOOT_ENV, ...vars })) vi.stubEnv(name, value);

  const record = { dbCloses: 0, exits: [] as number[], order: [] as string[] };
  let app: FastifyInstance | undefined;
  let publicHttp: IndexerPublicHttpDeps | undefined;
  let listenArgs: unknown;

  const sql = Object.assign(
    async (strings: TemplateStringsArray) => (strings.join('').includes('information_schema.tables') ? [{ exists: true }] : []),
    { unsafe: async () => [], begin: async () => [] },
  );
  vi.doMock('@intafaced/db', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@intafaced/db')>()),
    createDb: () => ({
      sql,
      close: async () => {
        record.dbCloses += 1;
        record.order.push('db');
      },
    }),
  }));
  vi.doMock('fastify', async (importOriginal) => {
    const real = await importOriginal<typeof import('fastify')>();
    const make = ((opts?: Parameters<typeof real.default>[0]) => {
      const built = real.default(opts);
      built.listen = (async (args: unknown) => {
        listenArgs = args;
        return '';
      }) as FastifyInstance['listen'];
      const close = built.close.bind(built);
      built.close = (async () => {
        record.order.push('app');
        await close();
      }) as FastifyInstance['close'];
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
  vi.doMock('../public-http.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../public-http.js')>();
    return {
      ...real,
      registerIndexerPublicHttp: async (target: FastifyInstance, deps: IndexerPublicHttpDeps) => {
        publicHttp = deps;
        return real.registerIndexerPublicHttp(target, deps);
      },
    };
  });

  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed: rpc.test is unreachable'));
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    record.exits.push(code ?? 0);
    record.order.push(`exit:${code ?? 0}`);
  }) as typeof process.exit);
  const before = new Map(SIGNALS.map((s) => [s, new Set(process.listeners(s))]));
  const added = (s: Signal) => process.listeners(s).filter((l) => !before.get(s)?.has(l)) as Array<() => void>;
  const signalHandlers = { SIGTERM: [] as Array<() => void>, SIGINT: [] as Array<() => void> };

  const exited = async (count = 1) => {
    for (let i = 0; i < 500 && record.exits.length < count; i += 1) await new Promise((r) => setTimeout(r, 10));
    if (record.exits.length < count) throw new Error(`the service asked to exit ${record.exits.length} times, not ${count}`);
  };
  const raise = (signal: Signal) => {
    for (const handler of signalHandlers[signal]) handler();
  };
  const cleanUp = async () => {
    for (const s of SIGNALS) for (const l of added(s)) process.removeListener(s, l);
    fetchSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllEnvs();
  };

  try {
    await import('../index.js');
    if (!app || !publicHttp) throw new Error('the entrypoint built no app or registered no public HTTP');
    await app.ready();
  } catch (err) {
    await app?.close();
    await cleanUp();
    throw err;
  } finally {
    vi.doUnmock('@intafaced/db');
    vi.doUnmock('fastify');
    vi.doUnmock('@intafaced/telemetry');
    vi.doUnmock('../public-http.js');
  }
  signalHandlers.SIGTERM.push(...added('SIGTERM'));
  signalHandlers.SIGINT.push(...added('SIGINT'));

  return {
    app,
    publicHttp,
    listenArgs,
    signalHandlers,
    record,
    raise,
    exited,
    close: async () => {
      if (record.exits.length === 0) {
        raise('SIGTERM');
        await exited();
      }
      await cleanUp();
    },
  };
}
