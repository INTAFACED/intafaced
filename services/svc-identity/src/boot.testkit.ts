import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { productionPostureIssues } from '@intafaced/config/production-posture';

/**
 * svc-identity as `index.ts` boots it, with only its three outside connections stood in: Postgres (every query answers
 * `answer(text, values)`, else no rows), the JetStream bus (publishes go nowhere) and the port (`listen` binds nothing).
 * Everything else is the production start: the real env.ts reading the given variables, every store, door, route and
 * router `index.ts` builds and mounts, in its order. A test asks the booted service, over Fastify's `inject` or its
 * merged tRPC router, what a caller gets; it never reads `index.ts`.
 *
 * Excluded from the production build (tsconfig.json), included in the test typecheck.
 */

/**
 * How long a test that boots may take. The first start in a file imports and transforms the whole service (some two
 * hundred modules): seconds on an idle runner, over 30 s (the shared TEST_BUDGET) on a loaded one.
 */
export const BOOT_TIMEOUT_MS = 120_000;

export const BOOT_SECRET = 'b'.repeat(32);
export const BOOT_INTERNAL_SECRET = 'i'.repeat(32);
const BOOT_JWT_SECRET = 'j'.repeat(32);

/** The fewest variables env.ts needs to load: secrets of the right length and a database address nothing dials. */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/identity',
  DATABASE_POOL_MAX: '5',
  EDGE_PRINCIPAL_SECRET: BOOT_SECRET,
  INTERNAL_SERVICE_SECRET: BOOT_INTERNAL_SECRET,
  JWT_ACCESS_SECRET: BOOT_JWT_SECRET,
};

/**
 * The service sees the base variables and `env`, and none of the host's development material: a runner that sets a
 * local chain URL or a published database password for other tests (CI's job env does) would otherwise make every
 * production-posture boot refuse on the host's value instead of the one the test is about.
 */
function stubIdentityEnv(env: Record<string, string | undefined>): void {
  vi.unstubAllEnvs();
  const given = { ...BASE_ENV, ...env };
  for (const [key, value] of Object.entries(process.env)) {
    if (key in given || value === undefined) continue;
    if (productionPostureIssues({ APP_ENV: 'prod', [key]: value }).length) vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries(given)) vi.stubEnv(key, value);
}

const PROCESS_EVENTS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection', 'beforeExit', 'exit'] as const;

export interface SqlCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** The rows one query answers; `undefined` means no rows. */
export type SqlAnswer = (call: SqlCall) => readonly unknown[] | undefined;

export interface IdentityBoot {
  /** The merged tRPC router `index.ts` exports. */
  readonly appRouter: (typeof import('./index.js'))['appRouter'];
  /** The Fastify app `index.ts` listened with: inject requests into it. */
  readonly app: FastifyInstance;
  /** Every query the service ran, in order. */
  readonly queries: SqlCall[];
}

const isFunction = (a: unknown): a is (tx: unknown) => unknown => typeof a === 'function';
const isListener = (a: unknown): a is (...args: unknown[]) => void => typeof a === 'function';

/**
 * A postgres.js stand-in: every query is recorded and answers `answer(call)` (else no rows); `begin` runs its body on
 * the same stand-in. `unsafe(text, values)` is a query of its own when awaited; written into another query it is a
 * fragment: its text takes its place there, and it is not recorded as a statement.
 */
export function recordingSql(answer: SqlAnswer = () => undefined): { sql: unknown; queries: SqlCall[] } {
  const queries: SqlCall[] = [];
  const fragments = new WeakMap<object, { call: SqlCall; text: string }>();
  const record = (text: string, values: unknown[]) => {
    const call: SqlCall = { text, values };
    queries.push(call);
    const rows = [...(answer(call) ?? [])];
    const self = (): Promise<unknown[]> => query;
    const query = Object.assign(Promise.resolve(rows), { values: self, raw: self, execute: self, simple: self, describe: self });
    return { call, query };
  };
  /** A tagged template: each value binds as `?`, except a fragment, whose text is written in its place. */
  const template = (strings: readonly unknown[], values: unknown[]) => {
    let text = String(strings[0] ?? '');
    const bound: unknown[] = [];
    values.forEach((value, i) => {
      const fragment = typeof value === 'object' && value !== null ? fragments.get(value) : undefined;
      if (fragment) {
        text += fragment.text;
        const at = queries.indexOf(fragment.call);
        if (at >= 0) queries.splice(at, 1);
      } else {
        text += '?';
        bound.push(value);
      }
      text += String(strings[i + 1] ?? '');
    });
    return record(text, bound).query;
  };
  const sql: unknown = new Proxy(function sql() {}, {
    apply: (_t, _this, args: unknown[]) => {
      const [strings, ...values] = args;
      return Array.isArray(strings) ? template(strings, values) : record(String(strings ?? ''), values).query;
    },
    get: (_t, key) => {
      if (key === 'then') return undefined;
      if (key === 'begin' || key === 'savepoint' || key === 'reserve')
        return async (...args: unknown[]) => {
          const fn = args.find(isFunction);
          return fn ? fn(sql) : sql;
        };
      if (key === 'unsafe')
        return (text: string, values: unknown[] = []) => {
          const { call, query } = record(text, values);
          fragments.set(query, { call, text });
          return query;
        };
      if (key === 'end' || key === 'close' || key === 'release') return async () => undefined;
      if (key === 'json' || key === 'array' || key === 'typed') return (v: unknown) => v;
      if (key === 'listen' || key === 'subscribe') return async () => ({ unlisten: async () => undefined });
      if (key === 'options') return { parsers: {}, serializers: {} };
      return (...args: unknown[]) => record(`sql.${String(key)}`, args).query;
    },
  });
  return { sql, queries };
}

/**
 * Boots `index.ts` with `env` over the base variables. Each call is a fresh start: modules are reset, so two boots in
 * one file are two services.
 */
export async function bootIdentity(
  env: Record<string, string | undefined> = {},
  answer: SqlAnswer = () => undefined,
): Promise<IdentityBoot> {
  vi.resetModules();
  stubIdentityEnv(env);
  const { sql, queries } = recordingSql(answer);
  const listened: FastifyInstance[] = [];
  vi.doMock('postgres', () => ({ default: () => sql }));
  vi.doMock('@intafaced/events', async (original) => {
    const real = await original<Record<string, unknown>>();
    class JetStreamEventBus {
      static async connect() {
        return new JetStreamEventBus();
      }
      async publish() {}
      async subscribe() {
        return { unsubscribe: async () => undefined };
      }
      async close() {}
    }
    return { ...real, JetStreamEventBus };
  });
  vi.doMock('fastify', async (original) => {
    const real = await original<{ default: (...args: unknown[]) => FastifyInstance }>();
    const factory = (...args: unknown[]) => {
      const app = real.default(...args);
      return Object.assign(app, {
        listen: async () => {
          await app.ready();
          listened.push(app);
          return '';
        },
      });
    };
    return { ...real, default: factory };
  });
  // The start hooks the process's signals and error events; a test boots many times, so those hooks are taken off again.
  const emitter: NodeJS.EventEmitter = process;
  const before = new Map(PROCESS_EVENTS.map((event) => [event, new Set(emitter.listeners(event))]));
  try {
    const mod = await import('./index.js');
    const app = listened[0];
    if (!app) throw new Error('index.ts finished without listening');
    return { appRouter: mod.appRouter, app, queries };
  } finally {
    for (const [event, had] of before) {
      for (const listener of emitter.listeners(event))
        if (!had.has(listener) && isListener(listener)) emitter.removeListener(event, listener);
    }
    vi.doUnmock('postgres');
    vi.doUnmock('@intafaced/events');
    vi.doUnmock('fastify');
  }
}

/** env.ts as the start loads it, from the base variables and `env` (a key set to undefined is unset). */
export async function loadIdentityEnv(env: Record<string, string | undefined> = {}): Promise<(typeof import('./env.js'))['env']> {
  vi.resetModules();
  stubIdentityEnv(env);
  return (await import('./env.js')).env;
}

/** A signed-in person's principal with these scopes, as the router reads it. */
export async function principalWith(
  scopes: readonly string[],
  opts: { userId?: string; mfa?: boolean; apiKeyId?: string } = {},
): Promise<Principal> {
  const config = { secret: BOOT_JWT_SECRET, issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };
  const { token } = await issueAccessToken(
    {
      userId: opts.userId ?? '11111111-1111-4111-8111-111111111111',
      sessionId: '44444444-4444-4444-8444-444444444444',
      scopes: [...scopes],
      tier: 'full',
      mfa: opts.mfa ?? true,
      ...(opts.apiKeyId ? { apiKeyId: opts.apiKeyId } : {}),
    },
    config,
  );
  return verifyAccessToken(token, config);
}

/** A tRPC context: a person with `scopes`, or (no scopes) a named service, or nobody. */
export async function contextWith(
  scopes: readonly string[],
  opts: { userId?: string; mfa?: boolean; service?: string } = {},
): Promise<Context> {
  return {
    principal: scopes.length ? await principalWith(scopes, opts) : null,
    service: opts.service ?? null,
    region: 'DE',
    requestId: 'req-boot',
  };
}
