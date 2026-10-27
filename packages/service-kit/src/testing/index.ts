/**
 * TEST SUPPORT. The set-up every service test file writes by hand today, written once.
 *
 * - `serviceMigrations(import.meta.url)`: the service's up migrations in order, found from the test file's folder.
 * - `useServiceDb({ service, from: import.meta.url })`: a fresh test database with those migrations for the file,
 *   emptied before each test and dropped after the last.
 * - `edgeCallers({ serviceName, scopes })`: request contexts built by `createEdgeContext` over real signed headers
 *   (signed, anonymous, forged), so a mounted router test never hand-writes a principal into its context.
 * - `expectRefusal(promise, code)`: the refusal assertion, for a service error or the `TRPCError` that carries it.
 *
 * Fixtures with domain meaning (a published course, a funded account) stay in the service: they are the test's story.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';

/** The nearest folder at or above `from` that holds `drizzle/`, the service's migrations. */
export function serviceDrizzleDir(from: string): string {
  let dir = dirname(from.startsWith('file:') ? fileURLToPath(from) : from);
  for (;;) {
    const candidate = join(dir, 'drizzle');
    if (existsSync(candidate) && existsSync(join(dir, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`serviceMigrations: no drizzle/ folder beside a package.json above ${from}`);
    dir = parent;
  }
}

/** The service's up migrations (`*.sql` but not `*.down.sql`), in name order, as the stack applies them. */
export function serviceMigrations(from: string): string[] {
  const drizzle = serviceDrizzleDir(from);
  return readdirSync(drizzle)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort()
    .map((name) => readFileSync(join(drizzle, name), 'utf8'));
}

export interface ServiceDbOptions {
  /** The service's schema name (`academy` for svc-academy). */
  readonly service: string;
  /** The test file's `import.meta.url`; its service's migrations are applied. */
  readonly from: string;
  /** Extra SQL after the migrations, for a fixture the schema needs. */
  readonly extra?: readonly string[];
  /** Admin URL; defaults to `TEST_DATABASE_URL`, as `createTestDatabase` does. */
  readonly url?: string;
  /** Leave rows between tests (a file that builds one world and reads it many ways). Defaults to false. */
  readonly keepRows?: boolean;
}

export interface ServiceDb {
  /** The connection, ready inside `it` and `beforeEach`. */
  readonly sql: TestDatabase['sql'];
  readonly db: TestDatabase;
}

/** Registers the file's database hooks and returns a handle whose `sql` is ready once the tests run. */
export function useServiceDb(options: ServiceDbOptions): ServiceDb {
  let db: TestDatabase | undefined;
  const ready = (): TestDatabase => {
    if (!db) throw new Error('useServiceDb: the database is ready only inside a test or a hook');
    return db;
  };
  beforeAll(async () => {
    db = await createTestDatabase({
      service: options.service,
      ...(options.url !== undefined ? { url: options.url } : {}),
      migrations: [...serviceMigrations(options.from), ...(options.extra ?? [])],
    });
  }, 120_000);
  if (!options.keepRows) {
    beforeEach(async () => {
      await ready().truncateAll();
    });
  }
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  return {
    get sql() {
      return ready().sql;
    },
    get db() {
      return ready();
    },
  };
}

export interface EdgeCallerOptions {
  /** `svc-academy`. */
  readonly serviceName: string;
  /** The scopes a signed caller holds unless a test says otherwise. */
  readonly scopes: readonly string[];
  /** Defaults to a test-only secret long enough for `createEdgeContext`. */
  readonly secret?: string;
  readonly region?: string;
}

export interface EdgeCallers {
  readonly secret: string;
  /** A principal with the default scopes; any field can be overridden. */
  principal(overrides?: Partial<Principal>): Principal;
  /** A context the edge signed for this principal (or the default one). */
  signed(principal?: Principal | Partial<Principal>): Context;
  /** A context with no principal. */
  anonymous(): Context;
  /** A context whose principal header carries no edge signature: the service must treat it as anonymous. */
  forged(principal?: Principal | Partial<Principal>): Context;
}

export const TEST_USER = '11111111-1111-4111-8111-111111111111';
export const TEST_SESSION = '22222222-2222-4222-8222-222222222222';

export function edgeCallers(options: EdgeCallerOptions): EdgeCallers {
  const secret = options.secret ?? `${options.serviceName}-service-kit-test-edge-secret`;
  const region = options.region ?? 'DE';
  const context = createEdgeContext({ secret, serviceName: options.serviceName });
  let n = 0;
  const principal = (overrides: Partial<Principal> = {}): Principal =>
    ({
      sub: overrides.userId ?? TEST_USER,
      userId: TEST_USER,
      sid: TEST_SESSION,
      scopes: [...options.scopes],
      tier: 'none',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    }) as Principal;
  const full = (p: Principal | Partial<Principal> | undefined): Principal =>
    p && 'expiresAt' in p && p.expiresAt instanceof Date && typeof p.userId === 'string' ? (p as Principal) : principal(p);
  return {
    secret,
    principal,
    signed(p) {
      const raw = encodePrincipal(full(p));
      return context({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, secret, region),
          'x-intafaced-region': region,
        },
        id: `req-signed-${++n}`,
      });
    },
    anonymous: () => context({ headers: { 'x-intafaced-region': region }, id: `req-anon-${++n}` }),
    forged: (p) =>
      context({ headers: { 'x-intafaced-principal': encodePrincipal(full(p)), 'x-intafaced-region': region }, id: `req-forged-${++n}` }),
  };
}

/** The refusal's code, whether the service threw it or a router wrapped it in a `TRPCError`. */
export function refusalCodeOf(err: unknown): string | undefined {
  const read = (e: unknown): string | undefined =>
    e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
  const cause = err && typeof err === 'object' && 'cause' in err ? read(err.cause) : undefined;
  return cause ?? read(err);
}

/**
 * Awaits a call that must refuse with `code`. Pass `status` to also check the tRPC status a router sent it as.
 * Returns the error for further checks (details, nothing written).
 */
export async function expectRefusal(call: Promise<unknown> | (() => Promise<unknown>), code: string, status?: string): Promise<unknown> {
  let thrown: unknown;
  try {
    await (typeof call === 'function' ? call() : call);
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `expected a refusal ${code}, but the call succeeded`).toBeDefined();
  expect(refusalCodeOf(thrown)).toBe(code);
  if (status !== undefined) expect((thrown as { code?: unknown }).code).toBe(status);
  return thrown;
}
