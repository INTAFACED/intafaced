/**
 * Privacy breach log (RC-identity-11): compliance opens an incident, one notice lands in the outbox in the same
 * transaction, the same incident twice keeps one record and one notice, other values for the same id refuse.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context, TRPCError } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createPrivacyRegisterRouter } from './privacy-router.js';

const SID = '44444444-4444-4444-8444-444444444444';
const OPS = '66666666-6666-4666-8666-666666666666';
const ADA = '11111111-1111-4111-8111-111111111111';
const tokenConfig = {
  secret: 'privacy-breach-identity-signing-secret-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const drizzle = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('privacy breach log (Postgres)', () => {
  let db: TestDatabase;
  let router: ReturnType<typeof createPrivacyRegisterRouter>;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'identity', url: adminUrl(), migrations });
    router = createPrivacyRegisterRouter(db.sql);
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  beforeEach(async () => {
    await db.sql`TRUNCATE identity.privacy_breach_notices, identity.privacy_breaches CASCADE`;
  });

  async function caller(userId: string, scopes: Array<'identity:read' | 'admin:compliance'>) {
    const { token } = await issueAccessToken({ userId, sessionId: SID, scopes, tier: 'none', mfa: true }, tokenConfig);
    const ctx: Context = {
      principal: await verifyAccessToken(token, tokenConfig),
      service: null,
      region: 'DE',
      requestId: `req-${randomUUID()}`,
    };
    return router.createCaller(ctx);
  }
  async function refusal(run: Promise<unknown>) {
    try {
      await run;
    } catch (err) {
      const e = err as TRPCError;
      return { trpc: e.code, message: e.message };
    }
    throw new Error('expected a refusal');
  }
  const counts = async () => {
    const [b] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM identity.privacy_breaches`;
    const [o] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM identity.privacy_breach_notices`;
    return { breaches: b?.n, notices: o?.n };
  };
  const incident = { incidentId: 'INC-2026-10-22-1', occurredAt: '2026-10-21T08:30:00.000Z', affectedCount: 42 };

  it('opens a breach with time and count, and queues exactly one notice for svc-notify', async () => {
    const ops = await caller(OPS, ['admin:compliance']);
    const opened = await ops.privacy.breach.open(incident);
    expect(opened).toMatchObject({ ...incident, changed: true });
    const notices = await db.sql<{ payload: unknown; delivered_at: Date | null }[]>`
      SELECT payload, delivered_at FROM identity.privacy_breach_notices WHERE incident_id = ${incident.incidentId}`;
    expect(notices).toEqual([{ payload: { kind: 'privacy.breach_opened', ...incident }, delivered_at: null }]);
  });

  it('opening the same incident twice keeps one record and one notice', async () => {
    const ops = await caller(OPS, ['admin:compliance']);
    const first = await ops.privacy.breach.open(incident);
    const again = await ops.privacy.breach.open(incident);
    expect(again).toEqual({ ...first, changed: false });
    expect(await counts()).toEqual({ breaches: 1, notices: 1 });
  });

  it('the same incident id with another count or time refuses and changes nothing', async () => {
    const ops = await caller(OPS, ['admin:compliance']);
    await ops.privacy.breach.open(incident);
    for (const other of [{ affectedCount: 43 }, { occurredAt: '2026-10-21T09:00:00.000Z' }]) {
      const r = await refusal(ops.privacy.breach.open({ ...incident, ...other }));
      expect(r.trpc).toBe('CONFLICT');
      expect(r.message).toContain('identity.privacy_breach_conflict');
    }
    expect(await counts()).toEqual({ breaches: 1, notices: 1 });
  });

  it('refuses a bad incident id, time or count with a typed code and writes nothing', async () => {
    const ops = await caller(OPS, ['admin:compliance']);
    for (const bad of [
      { incidentId: ' ' },
      { incidentId: 'has space' },
      { occurredAt: 'yesterday' },
      { occurredAt: '2999-01-01T00:00:00.000Z' },
      { affectedCount: -1 },
    ]) {
      const r = await refusal(ops.privacy.breach.open({ ...incident, ...bad }));
      expect(r.trpc).toBe('BAD_REQUEST');
      expect(r.message).toContain('identity.privacy_breach_invalid');
    }
    expect(await counts()).toEqual({ breaches: 0, notices: 0 });
  });

  it('is compliance-only: a customer cannot open a breach', async () => {
    const customer = await caller(ADA, ['identity:read']);
    expect((await refusal(customer.privacy.breach.open(incident))).trpc).toBe('FORBIDDEN');
    expect(await counts()).toEqual({ breaches: 0, notices: 0 });
  });
});
