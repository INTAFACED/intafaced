/**
 * Test support: boots the real entrypoint (`src/index.ts`) inside the test process, so a test asks the booted
 * service what it wired instead of reading the file.
 *
 * What is stood in, and only that: Postgres (`postgres()` returns a connection that answers every query with no
 * rows and records what it was asked), NATS (`JetStreamEventBus.connect` returns a bus that records subscriptions),
 * the network (every `fetch` fails as unreachable unless the test passes its own), `listen` (recorded, no port opens),
 * telemetry and process hooks (off), and `process.exit` (recorded). Every module of the service itself is the real
 * one. The harness keeps what the entrypoint handed the pieces a test asks about: the guest ingress context's
 * options, the AlertService, NotificationDispatcher and NotifyService arguments, the tRPC plugin options, and every interval it started.
 *
 * `close` shuts the service down the way the container does, by raising SIGTERM through the entrypoint's own
 * handler, then clears what the boot left behind.
 */
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';

/** The secret the booted service verifies the edge principal with. Fixture only. */
export const BOOT_EDGE_SECRET = 'svc-notify-boot-harness-edge-secret-long-x';

/** A complete environment for a boot. Fixture values only. */
const BOOT_ENV: Readonly<Record<string, string>> = {
  SERVICE_NAME: 'svc-notify',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/intafaced_notify_test',
  DATABASE_POOL_MAX: '2',
  EDGE_PRINCIPAL_SECRET: BOOT_EDGE_SECRET,
  NATS_URL: 'nats://127.0.0.1:1',
  NOTIFY_MAX_DELIVERY_ATTEMPTS: '3',
  NOTIFY_VERIFY_TTL_MINUTES: '15',
  OTEL_ENABLED: 'false',
  LOG_LEVEL: 'fatal',
};

type Signal = 'SIGTERM' | 'SIGINT';
const SIGNALS: readonly Signal[] = ['SIGTERM', 'SIGINT'];

export interface StartedInterval {
  readonly delayMs: number | undefined;
  /** What the interval runs on each tick. */
  readonly tick: () => void;
  readonly handle: ReturnType<typeof setInterval>;
  /** Whether the shutdown handler (or anything) cleared it. */
  cleared: boolean;
}

export interface BootedNotify {
  readonly app: FastifyInstance;
  /** The options the entrypoint handed `createGuestIngressContext`. */
  readonly guestIngressOptions: unknown;
  /** The arguments the entrypoint handed `new AlertService` (store, marks, notify, whale marks, …). */
  readonly alertServiceArgs: readonly unknown[];
  /** The options (fourth argument) the entrypoint handed `new NotificationDispatcher`. */
  readonly dispatcherOptions: Record<string, unknown>;
  /** The stores and boards (third argument) the entrypoint handed `new NotifyService`. */
  readonly notifyDeps: Record<string, unknown>;
  /** The options (second argument) the entrypoint handed `new NotifyService`. */
  readonly notifyOptions: Record<string, unknown>;
  /** The trpcOptions the entrypoint registered `fastifyTRPCPlugin` with, and its prefix. */
  readonly trpc: { prefix: string; createContext: (opts: { req: unknown; res: unknown }) => unknown };
  /** Every interval the boot started, in order. */
  readonly intervals: StartedInterval[];
  /** The subjects the boot subscribed to on the bus. */
  readonly subscribed: string[];
  /** Every query text the boot sent Postgres so far. */
  readonly queries: string[];
  /** The exit codes asked for so far. */
  readonly exits: number[];
  readonly raise: (signal: Signal) => void;
  readonly exited: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** A Postgres stand-in: every query resolves to no rows; helpers return inert fragments. */
function fakeSql(queries: string[]) {
  const fragment = { __fragment: true };
  const isTemplate = (first: unknown): first is TemplateStringsArray => Array.isArray(first) && 'raw' in first;
  const tag = (first: unknown) => {
    if (isTemplate(first)) {
      queries.push(first.join('$?'));
      return Promise.resolve(Object.assign([], { count: 0 }));
    }
    return fragment;
  };
  const sql = Object.assign(tag, {
    unsafe: async (text: string) => {
      queries.push(text);
      return [];
    },
    begin: async (fn: (tx: unknown) => unknown) => fn(sql),
    json: (v: unknown) => v,
    array: (v: unknown) => v,
    end: async () => undefined,
  });
  return sql;
}

/** Boot `src/index.ts` with BOOT_ENV and `vars` (a `vars` entry wins; `undefined` unsets). A boot that throws rethrows. */
export async function bootNotify(
  vars: Record<string, string | undefined> = {},
  options: { fetch?: typeof fetch } = {},
): Promise<BootedNotify> {
  vi.resetModules();
  for (const [name, value] of Object.entries({ ...BOOT_ENV, ...vars })) vi.stubEnv(name, value);

  const queries: string[] = [];
  const subscribed: string[] = [];
  const exits: number[] = [];
  const intervals: StartedInterval[] = [];
  let app: FastifyInstance | undefined;
  let guestIngressOptions: unknown;
  let notifyOptions: Record<string, unknown> = {};
  let notifyDeps: Record<string, unknown> = {};
  let alertServiceArgs: unknown[] = [];
  let dispatcherOptions: Record<string, unknown> = {};
  let trpc: BootedNotify['trpc'] | undefined;

  vi.doMock('postgres', () => ({ default: () => fakeSql(queries) }));
  vi.doMock('@intafaced/events', async (importOriginal) => {
    const real = await importOriginal<typeof import('@intafaced/events')>();
    class RecordingBus {
      static async connect() {
        return new RecordingBus();
      }
      async subscribe(event: { subject?: string } | string) {
        subscribed.push(typeof event === 'string' ? event : String(event.subject ?? ''));
        return { unsubscribe: async () => undefined };
      }
      async publish() {
        return undefined;
      }
      async close() {
        return undefined;
      }
    }
    return { ...real, JetStreamEventBus: RecordingBus };
  });
  vi.doMock('fastify', async (importOriginal) => {
    const real = await importOriginal<typeof import('fastify')>();
    const make = ((opts?: Parameters<typeof real.default>[0]) => {
      const built = real.default(opts);
      built.listen = (async () => '') as FastifyInstance['listen'];
      const register = built.register.bind(built);
      built.register = ((plugin: unknown, options?: { prefix?: string; trpcOptions?: { createContext: never } }) => {
        if (options?.trpcOptions) trpc = { prefix: options.prefix ?? '', createContext: options.trpcOptions.createContext };
        return register(plugin as never, options as never);
      }) as FastifyInstance['register'];
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
  vi.doMock('../guests/context.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../guests/context.js')>();
    return {
      ...real,
      createGuestIngressContext: (options: Parameters<typeof real.createGuestIngressContext>[0]) => {
        guestIngressOptions = options;
        return real.createGuestIngressContext(options);
      },
    };
  });
  vi.doMock('../notify-service.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../notify-service.js')>();
    class RecordedNotifyService extends real.NotifyService {
      constructor(...args: ConstructorParameters<typeof real.NotifyService>) {
        super(...args);
        notifyOptions = { ...args[1] };
        notifyDeps = { ...args[2] };
      }
    }
    return { ...real, NotifyService: RecordedNotifyService };
  });

  vi.doMock('../dispatch.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../dispatch.js')>();
    class RecordedDispatcher extends real.NotificationDispatcher {
      constructor(...args: ConstructorParameters<typeof real.NotificationDispatcher>) {
        super(...args);
        dispatcherOptions = { ...args[3] };
      }
    }
    return { ...real, NotificationDispatcher: RecordedDispatcher };
  });
  vi.doMock('../alerts/service.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../alerts/service.js')>();
    class RecordedAlertService extends real.AlertService {
      constructor(...args: ConstructorParameters<typeof real.AlertService>) {
        super(...args);
        alertServiceArgs = args;
      }
    }
    return { ...real, AlertService: RecordedAlertService };
  });

  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
    const handle = realSetInterval(fn, delay);
    intervals.push({ delayMs: delay, tick: fn, handle, cleared: false });
    return handle;
  }) as typeof setInterval);
  const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((handle?: ReturnType<typeof setInterval>) => {
    for (const started of intervals) if (started.handle === handle) started.cleared = true;
    realClearInterval(handle);
  }) as typeof clearInterval);
  const fetchSpy = options.fetch
    ? vi.spyOn(globalThis, 'fetch').mockImplementation(options.fetch)
    : vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed: unreachable in the boot harness'));
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
  }) as typeof process.exit);
  const before = new Map(SIGNALS.map((s) => [s, new Set(process.listeners(s))]));
  const added = (s: Signal) => process.listeners(s).filter((l) => !before.get(s)?.has(l)) as Array<() => void>;
  const handlers = { SIGTERM: [] as Array<() => void>, SIGINT: [] as Array<() => void> };

  const raise = (signal: Signal) => {
    for (const handler of handlers[signal]) handler();
  };
  const exited = async () => {
    for (let i = 0; i < 500 && exits.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    if (exits.length === 0) throw new Error('the service never asked to exit');
  };
  const cleanUp = async () => {
    for (const s of SIGNALS) for (const l of added(s)) process.removeListener(s, l);
    for (const started of intervals) realClearInterval(started.handle);
    intervalSpy.mockRestore();
    clearSpy.mockRestore();
    fetchSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllEnvs();
  };

  try {
    await import('../index.js');
    if (!app || !trpc) throw new Error('the entrypoint built no app or mounted no tRPC');
    await app.ready();
  } catch (err) {
    await app?.close();
    await cleanUp();
    throw err;
  } finally {
    for (const name of [
      'postgres',
      '@intafaced/events',
      'fastify',
      '@intafaced/telemetry',
      '../guests/context.js',
      '../notify-service.js',
      '../dispatch.js',
      '../alerts/service.js',
    ]) {
      vi.doUnmock(name);
    }
  }
  handlers.SIGTERM.push(...added('SIGTERM'));
  handlers.SIGINT.push(...added('SIGINT'));

  return {
    app,
    guestIngressOptions,
    alertServiceArgs,
    dispatcherOptions,
    notifyOptions,
    notifyDeps,
    trpc,
    intervals,
    subscribed,
    queries,
    exits,
    raise,
    exited,
    close: async () => {
      if (exits.length === 0) {
        raise('SIGTERM');
        await exited();
      }
      await cleanUp();
    },
  };
}
