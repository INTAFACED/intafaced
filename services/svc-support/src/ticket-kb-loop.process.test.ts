import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { assertTestDatabase, createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createSupportHttpApp } from './http-app.js';
import { createSupportRouter } from './router.js';
import { PostgresSupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { createTicketKbLoopObserver } from './ticket-kb-loop-observation.js';

/**
 * Process compose proof — ticket create + KB search/get on the same Fastify
 * mount `index.ts` listens on. Store-only suites and a flipped
 * TICKET_KB_LOOP_OBSERVED_IN_LIVE_COMPOSE boolean do not satisfy this.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
// Every migration, in order: the store writes columns later migrations add, which this file once got only from other
// files migrating the shared database further.
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'));

const SECRET = 'a-support-ticket-kb-process-edge-secret-long';
const IDENTITY_SECRET = 'a-support-ticket-kb-process-identity-secret';
const USER = '11111111-1111-4111-8111-111111111111';

// A per-run database (#6713): on the shared intafaced_test, other files' migration replays and truncates ran under this
// file's tests.
const available = await postgresAvailable(ADMIN_URL);
const db: TestDatabase | null = available ? await createTestDatabase({ service: 'support', url: ADMIN_URL, migrations: MIGRATIONS }) : null;
const sql = db?.sql ?? null;
if (sql) await assertTestDatabase(sql, 'svc-support ticket-kb-loop.process.test');

afterAll(async () => {
  await db?.drop();
}, 30_000);

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-support' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['support:read', 'support:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string };
};

function trpcData<T>(body: WireBody): T {
  return body.result?.data as T;
}

async function mountProcess() {
  const loop = createTicketKbLoopObserver();
  const support = new SupportService(new PostgresSupportStore(sql!));
  const app = await createSupportHttpApp({
    router: createSupportRouter(support, loop),
    edgeContext,
    serviceName: 'svc-support',
    identitySecret: IDENTITY_SECRET,
    loop,
  });
  return { app, loop };
}

describe.skipIf(!available)('mounted Fastify/tRPC ticket+KB loop (process compose)', () => {
  beforeEach(async () => {
    // Ticket removal no longer clears the audit, so this suite resets its own tables.
    await sql!.unsafe(
      'TRUNCATE TABLE support.comments, support.ticket_events, support.case_files, support.tickets RESTART IDENTITY CASCADE',
    );
  });

  it('/ready reports zeros until this process succeeds ticket create + KB search/get', async () => {
    const { app } = await mountProcess();
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    const body = ready.json() as {
      ticketKbLoopObservedInLiveCompose: boolean;
      lastTicketCreateAtMs: number;
      lastKbSearchAtMs: number;
      lastKbGetAtMs: number;
    };
    expect(body.ticketKbLoopObservedInLiveCompose).toBe(false);
    expect(body.lastTicketCreateAtMs).toBe(0);
    expect(body.lastKbSearchAtMs).toBe(0);
    expect(body.lastKbGetAtMs).toBe(0);
    await app.close();
  });

  it('create + searchKb (seeded) + getKb through inject, then /ready stamps those successes', async () => {
    const before = Date.now();
    const { app } = await mountProcess();

    const created = await app.inject({
      method: 'POST',
      url: '/trpc/create',
      headers: signedHeaders(),
      payload: { category: 'account', subject: 'Cannot sign in', body: 'Need help' },
    });
    expect(created.statusCode).toBe(200);
    const ticket = trpcData<{ id: string; subject: string }>(created.json() as WireBody);
    expect(ticket.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ticket.subject).toBe('Cannot sign in');

    const searched = await app.inject({
      method: 'GET',
      url: `/trpc/searchKb?input=${encodeURIComponent(JSON.stringify({ q: 'account', limit: 100 }))}`,
    });
    expect(searched.statusCode).toBe(200);
    const hits = trpcData<Array<{ id: string }>>(searched.json() as WireBody);
    expect(hits.some((a) => a.id === 'kb-account-access')).toBe(true);

    const got = await app.inject({
      method: 'GET',
      url: `/trpc/getKb?input=${encodeURIComponent(JSON.stringify({ id: 'kb-account-access' }))}`,
    });
    expect(got.statusCode).toBe(200);
    const article = trpcData<{ id: string } | null>(got.json() as WireBody);
    expect(article?.id).toBe('kb-account-access');

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    const body = ready.json() as {
      ticketKbLoopObservedInLiveCompose: boolean;
      lastTicketCreateAtMs: number;
      lastKbSearchAtMs: number;
      lastKbGetAtMs: number;
    };
    expect(body.ticketKbLoopObservedInLiveCompose).toBe(false);
    expect(body.lastTicketCreateAtMs).toBeGreaterThanOrEqual(before);
    expect(body.lastKbSearchAtMs).toBeGreaterThanOrEqual(before);
    expect(body.lastKbGetAtMs).toBeGreaterThanOrEqual(before);
    await app.close();
  });
});
