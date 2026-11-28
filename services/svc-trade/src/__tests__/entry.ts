/**
 * svc-trade's entry and env, as a test drives them instead of reading their source.
 *
 * `tradeEnvOf` parses svc-trade's own env schema from only the keys it requires, so a test sees each default and
 * transform as a deploy that sets nothing gets it. `bootTrade` boots the real entry (`index.ts`) in this test process,
 * with only its outside connections replaced: the Postgres pool (every query answers no rows) and the JetStream bus (an
 * in-memory bus that keeps what is published and delivers to the handlers the entry subscribes). Everything else is the
 * entry's own start-up, so a test asks what the running service mounts, subscribes and constructs.
 */
import { vi } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { partial } from '@intafaced/service-kit/testing';
import { tradeEnvSchema } from '../env.js';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';

/** The keys svc-trade's env requires, as labelled test-only placeholders (the same as vitest.config.ts). */
export const REQUIRED_TRADE_ENV = {
  DATABASE_URL: 'postgres://svc_trade@127.0.0.1:5432/intafaced_trade_test',
  DATABASE_POOL_MAX: '2',
  EDGE_PRINCIPAL_SECRET: 'test-only-edge-principal-secret-0123456789',
  INTERNAL_SERVICE_SECRET: 'test-only-internal-service-secret-0123456789',
} as const;

/** svc-trade's env as a deploy that sets only the required keys and `over` gets it. */
export function tradeEnvOf(over: Record<string, string> = {}) {
  return tradeEnvSchema.parse({ ...REQUIRED_TRADE_ENV, ...over });
}

export interface BootedTrade {
  /** The base URL the booted service listens on. */
  url: string;
  /** The in-memory bus the entry connected to. */
  bus: MemoryEventBus;
  /** Every query the entry ran on the pool, as its joined text. */
  queries: string[];
  /** The arguments of each call the entry made to a spied export (a class: each `new`), by export name. */
  calls: Record<string, unknown[][]>;
  /** What each of those calls returned (a class: the instance), in the same order. */
  results: Record<string, unknown[]>;
  /** Request one path on the booted service. */
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** What a boot records besides its answers: how often the pool was opened, and each spied call. */
export interface BootRecord {
  poolsOpened: number;
  queries: string[];
  calls: Record<string, unknown[][]>;
  results: Record<string, unknown[]>;
}

export interface BootOptions {
  /**
   * Exports to record, by the module that defines them (a path from `src/`, as `index.ts` imports it): each call's
   * arguments are kept and the real export still runs. A class is recorded at each `new`.
   */
  spy?: Readonly<Record<string, readonly string[]>>;
  /** Filled as the boot runs, so a boot that refuses still says what it did before refusing. */
  record?: BootRecord;
}

/** Every procedure path svc-trade's tRPC router mounts (`orders.create`, `admin.fees.get`, ...), sorted. */
export function tradeRouterPaths(): string[] {
  return Object.keys(createTradeRouter(partial<TradeService>({}))._def.procedures).sort();
}

/** A Postgres pool that runs nothing: each query is recorded and answers no rows. */
function fakeSql(queries: string[]) {
  const answer = (text: string) => {
    queries.push(text);
    const rows = Object.assign([] as unknown[], { count: 0 });
    const done = Promise.resolve(rows);
    return Object.assign(done, {
      values: () => Promise.resolve([]),
      raw: () => Promise.resolve([]),
      execute: () => done,
      cursor: async function* () {},
      forEach: async () => rows,
      describe: async () => ({}),
    });
  };
  const sql = ((first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && 'raw' in first) return answer((first as string[]).join('?'));
    // sql(value) / sql(object, ...columns): a fragment helper; nothing runs.
    return { first, rest };
  }) as Record<string, unknown> & ((...a: unknown[]) => unknown);
  Object.assign(sql, {
    unsafe: (text: string) => answer(text),
    begin: async (...args: unknown[]) => (args.at(-1) as (tx: unknown) => unknown)(sql),
    savepoint: async (fn: (tx: unknown) => unknown) => fn(sql),
    reserve: async () => Object.assign(sql, { release: () => undefined }),
    end: async () => undefined,
    listen: async () => ({ unlisten: async () => undefined }),
    notify: async () => undefined,
    json: (v: unknown) => v,
    array: (v: unknown) => v,
    typed: (v: unknown) => v,
    options: { parsers: {}, serializers: {} },
  });
  return sql;
}

const isClass = (fn: unknown): fn is new (...args: unknown[]) => object =>
  typeof fn === 'function' && /^class\b/.test(Function.prototype.toString.call(fn));

/**
 * Boot the entry with `env` laid over the test env (a key set to `undefined` is removed for the boot) and wait until it
 * listens. Call `close()` after. A boot the entry refuses rejects with the entry's own error.
 */
export async function bootTrade(env: Record<string, string | undefined> = {}, options: BootOptions = {}): Promise<BootedTrade> {
  const record = options.record ?? { poolsOpened: 0, queries: [], calls: {}, results: {} };
  const bus = new MemoryEventBus('svc-trade');
  const saved = { ...process.env };
  const boot = { HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', OTEL_ENABLED: 'false', LOG_LEVEL: 'fatal', ...env };
  for (const [key, value] of Object.entries(boot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mocked: string[] = [];
  const mock = (path: string, factory: Parameters<typeof vi.doMock>[1]) => {
    vi.doMock(path, factory);
    mocked.push(path);
  };
  let listening: { url: string; close(): Promise<void> } | undefined;
  vi.resetModules();
  mock('postgres', () => ({
    default: () => {
      record.poolsOpened += 1;
      return fakeSql(record.queries);
    },
  }));
  mock('@intafaced/events', async (importOriginal) => {
    const original = await importOriginal<typeof import('@intafaced/events')>();
    return { ...original, JetStreamEventBus: { connect: async () => bus } };
  });
  mock('fastify', async (importOriginal) => {
    const original = await importOriginal<{
      default: (...a: unknown[]) => { listen(o: unknown): Promise<string>; close(): Promise<void> };
    }>();
    return {
      ...original,
      default: (...args: unknown[]) => {
        const app = original.default(...args);
        const listen = app.listen.bind(app);
        app.listen = async (opts: unknown) => {
          const url = await listen(opts);
          listening = { url, close: () => app.close() };
          return url;
        };
        return app;
      },
    };
  });
  for (const [from, names] of Object.entries(options.spy ?? {})) {
    const path = new URL(from.replace(/\.js$/, '.ts'), new URL('../', import.meta.url)).pathname;
    mock(path, async (importOriginal) => {
      const original = await importOriginal<Record<string, unknown>>();
      const out: Record<string, unknown> = { ...original };
      for (const name of names) {
        const real = original[name];
        if (typeof real !== 'function') throw new Error(`${from} exports no function ${name}`);
        const list = (record.calls[name] ??= []);
        const answers = (record.results[name] ??= []);
        out[name] = isClass(real)
          ? class extends real {
              constructor(...args: unknown[]) {
                super(...args);
                list.push(args);
                answers.push(this);
              }
            }
          : (...args: unknown[]) => {
              list.push(args);
              const answer = (real as (...a: unknown[]) => unknown)(...args);
              answers.push(answer);
              return answer;
            };
      }
      return out;
    });
  }
  const unmock = () => {
    for (const path of mocked) vi.doUnmock(path);
    vi.resetModules();
  };
  try {
    await import('../index.js');
  } catch (err) {
    unmock();
    throw err;
  } finally {
    process.env = saved;
  }
  if (!listening) {
    unmock();
    throw new Error('svc-trade entry loaded but never listened');
  }
  const { url, close } = listening;
  return {
    url,
    bus,
    queries: record.queries,
    calls: record.calls,
    results: record.results,
    request: (path, init) => fetch(new URL(path, url), { signal: AbortSignal.timeout(10_000), ...init }),
    close: async () => {
      await close();
      unmock();
    },
  };
}
