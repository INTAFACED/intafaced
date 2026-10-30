import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { sandboxFundRequestId, sandboxResetRequestId } from '@intafaced/contracts/developer-sandboxes';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxFundsRouter } from './router.js';
import type { SandboxFundSettings } from './settings.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_sandbox_store_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const TEST: SandboxFundSettings = { fundAmount: '1000', resetsPerDay: 2 };

const ctxOf = (userId: string): Context => ({
  principal: {
    userId,
    sub: userId,
    sid: randomUUID(),
    scopes: ['trade:read', 'trade:write'],
    mfa: true,
    tier: 'none',
    expiresAt: new Date(Date.now() + 600_000),
  } as Principal,
  service: null,
  region: 'DE',
  requestId: randomUUID(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

describe('sandbox store (DV-sandbox-02)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  const as = (userId: string, settings: SandboxFundSettings = TEST) =>
    createSandboxFundsRouter({ sql, settings }).createCaller(ctxOf(userId)).sandboxFunds;

  /** Every row count outside the sandbox tables, to prove a change writes nowhere else. */
  async function everythingElse(): Promise<Record<string, number>> {
    const tables = await sql<Array<{ s: string; t: string }>>`
      SELECT table_schema AS s, table_name AS t FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_name NOT LIKE 'sandbox\\_%'`;
    const counts: Record<string, number> = {};
    for (const { s, t } of tables) {
      const [row] = await sql.unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${s}"."${t}"`);
      counts[`${s}.${t}`] = row!.n;
    }
    return counts;
  }

  it('starts at zero TEST, funds by the owner amount once per request id, and writes nothing outside the store', async () => {
    const user = randomUUID();
    const sandboxId = randomUUID();
    const before = await everythingElse();
    const empty = await as(user).balance({ sandboxId });
    expect(empty).toMatchObject({
      label: 'TEST',
      asset: 'USDT',
      amount: '0',
      version: 0,
      fundAmount: '1000',
      resetsPerDay: 2,
      resetsToday: 0,
    });

    const requestId = sandboxFundRequestId(user, sandboxId, empty.version);
    const funded = await as(user).fund({ sandboxId, requestId });
    expect(funded).toMatchObject({ amount: '1000', version: 1 });
    // A double press (same request id) is one change.
    expect(await as(user).fund({ sandboxId, requestId })).toMatchObject({ amount: '1000', version: 1 });
    expect(await as(user).fund({ sandboxId, requestId: sandboxFundRequestId(user, sandboxId, 1) })).toMatchObject({
      amount: '2000',
      version: 2,
    });
    expect(await everythingElse()).toEqual(before);
  });

  it('keeps each account to its own rows: another account pressing the same sandbox id changes only its own', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const sandboxId = randomUUID();
    await as(owner).fund({ sandboxId, requestId: sandboxFundRequestId(owner, sandboxId, 0) });
    await as(other).fund({ sandboxId, requestId: sandboxFundRequestId(other, sandboxId, 0) });
    await as(other).fund({ sandboxId, requestId: sandboxFundRequestId(other, sandboxId, 1) });
    expect((await as(owner).balance({ sandboxId })).amount).toBe('1000');
    expect((await as(other).balance({ sandboxId })).amount).toBe('2000');
  });

  it("refuses another change's request id as a conflict and changes nothing", async () => {
    const user = randomUUID();
    const sandboxId = randomUUID();
    const requestId = sandboxFundRequestId(user, sandboxId, 0);
    await as(user).fund({ sandboxId, requestId });
    await expect(as(user).reset({ sandboxId, requestId })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'pay.sandbox_request_conflict' },
    });
    await expect(as(randomUUID()).fund({ sandboxId, requestId })).rejects.toMatchObject({
      cause: { code: 'pay.sandbox_request_conflict' },
    });
    expect(await as(user).balance({ sandboxId })).toMatchObject({ amount: '1000', version: 1 });
  });

  it('resets to zero up to the daily cap, then refuses by name; a fund after a reset is a new change', async () => {
    const user = randomUUID();
    const sandboxId = randomUUID();
    await as(user).fund({ sandboxId, requestId: sandboxFundRequestId(user, sandboxId, 0) });
    const first = await as(user).reset({ sandboxId, requestId: sandboxResetRequestId(user, sandboxId, 1) });
    expect(first).toMatchObject({ amount: '0', version: 2, resetsToday: 1 });
    const again = await as(user).fund({ sandboxId, requestId: sandboxFundRequestId(user, sandboxId, 2) });
    expect(again).toMatchObject({ amount: '1000', version: 3 });
    expect(await as(user).reset({ sandboxId, requestId: sandboxResetRequestId(user, sandboxId, 3) })).toMatchObject({
      amount: '0',
      resetsToday: 2,
    });
    const before = await sql`SELECT count(*)::int AS n FROM pay.sandbox_events`;
    await expect(as(user).reset({ sandboxId, requestId: sandboxResetRequestId(user, sandboxId, 4) })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('daily reset limit'),
      cause: { code: 'pay.sandbox_reset_cap_reached' },
    });
    expect(await sql`SELECT count(*)::int AS n FROM pay.sandbox_events`).toEqual(before);
  });

  it('two presses at once with one request id make one change', async () => {
    const user = randomUUID();
    const sandboxId = randomUUID();
    const requestId = sandboxFundRequestId(user, sandboxId, 0);
    const both = await Promise.all([as(user).fund({ sandboxId, requestId }), as(user).fund({ sandboxId, requestId })]);
    expect(both.map((b) => b.amount)).toEqual(['1000', '1000']);
    expect(await as(user).balance({ sandboxId })).toMatchObject({ amount: '1000', version: 1 });
  });

  it('with the settings blank, the balance still reads and says so, and Fund and Reset refuse', async () => {
    const user = randomUUID();
    const sandboxId = randomUUID();
    const blank = { fundAmount: null, resetsPerDay: null };
    expect(await as(user, blank).balance({ sandboxId })).toMatchObject({ amount: '0', fundAmount: null, resetsPerDay: null });
    await expect(as(user, blank).fund({ sandboxId, requestId: sandboxFundRequestId(user, sandboxId, 0) })).rejects.toMatchObject({
      cause: { code: 'pay.sandbox_funds_unset' },
    });
  });
});
