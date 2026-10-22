/**
 * Broker / DMA client links against Postgres (RC-identity-09, TRD-0038): law gate, client-accepted links, revocation by CAS
 * with history kept, append-only commission schedules, allocation records, and evidence for the client only.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context, TRPCError } from '@intafaced/contracts';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { BrokerClientService } from './broker-clients.js';
import { createBrokerRouter } from './broker-router.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'a-broker-client-links-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);

if (!available) {
  describe.skip('broker client links (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  const api = createBrokerRouter(new BrokerClientService(db.sql, { published: true }));
  const closed = createBrokerRouter(new BrokerClientService(db.sql, { published: false }));

  const seed = async (): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `b${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${'test-password-hash'})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${true}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken(
      { userId, sessionId, scopes: ['identity:read', 'identity:write'] as never, mfa: true },
      tokens,
    );
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };
  const id = (c: Context) => c.principal!.userId;
  async function refusal(run: Promise<unknown>) {
    try {
      await run;
    } catch (err) {
      const wrapped = err as TRPCError & { cause?: { code?: string } };
      return { trpc: wrapped.code, code: wrapped.cause?.code };
    }
    throw new Error('expected a refusal');
  }

  let admin: Context;
  let trader: Context;
  let client: Context;
  let other: Context;
  let orgId: string;
  beforeEach(async () => {
    await db.truncateAll();
    [admin, trader, client, other] = [await seed(), await seed(), await seed(), await seed()];
    const [org] = await db.sql<
      Array<{ id: string }>
    >`INSERT INTO organizations (name, created_by) VALUES ('Broker Ltd', ${id(admin)}) RETURNING id`;
    orgId = org!.id;
    await db.sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${id(admin)}, 'admin'), (${orgId}, ${id(trader)}, 'trader')`;
  });
  afterAll(async () => {
    await db.drop();
  });
  const as = (c: Context) => api.createCaller(c).broker;
  const rows = [{ product: 'spot', rate: '0.0015' }];

  it('refuses every write while the DMA hierarchy law is unpublished', async () => {
    const c = closed.createCaller(admin).broker;
    const link = { orgId, clientUserId: id(client) };
    for (const run of [
      c.client.invite({ ...link, clientTag: 'VIP-1' }),
      closed.createCaller(client).broker.client.accept({ orgId }),
      c.client.revoke(link),
      c.schedule.publish({ orgId, rows }),
      c.allocate({ ...link, instruction: { order: 'o-1', qty: '1' } }),
    ]) {
      expect(await refusal(run)).toMatchObject({ trpc: 'PRECONDITION_FAILED', code: 'identity.dma.hierarchy_law_unset' });
    }
    expect(await db.sql`SELECT 1 FROM broker_clients`).toHaveLength(0);
  });

  it('invite and accept are idempotent; the client then reads tag, schedule version and allocations', async () => {
    const link = { orgId, clientUserId: id(client) };
    expect(await as(admin).client.invite({ ...link, clientTag: 'VIP-1' })).toEqual({ status: 'invited', changed: true });
    expect(await as(admin).client.invite({ ...link, clientTag: 'VIP-1' })).toEqual({ status: 'invited', changed: false });
    // Not accepted yet: nothing can be allocated.
    expect((await refusal(as(admin).allocate({ ...link, instruction: { order: 'o-1' } }))).code).toBe('identity.broker_client_not_active');
    expect(await as(client).client.accept({ orgId })).toEqual({ status: 'active', changed: true });
    expect(await as(client).client.accept({ orgId })).toEqual({ status: 'active', changed: false });

    expect(await as(admin).schedule.publish({ orgId, rows })).toEqual({ version: 1 });
    expect(await as(admin).schedule.publish({ orgId, rows: [{ product: 'spot', rate: '0.001' }] })).toEqual({ version: 2 });
    const first = await as(admin).allocate({ ...link, instruction: { order: 'o-1', qty: '2' } });
    expect(first.changed).toBe(true);
    // Same instruction, keys in another order: the same record.
    expect(await as(admin).allocate({ ...link, instruction: { qty: '2', order: 'o-1' } })).toEqual({ ...first, changed: false });

    const evidence = await as(client).evidence.mine({ orgId });
    expect(evidence).toMatchObject({
      orgId,
      clientTag: 'VIP-1',
      status: 'active',
      schedule: { version: 2, rows: [{ product: 'spot', rate: '0.001' }] },
      allocations: [{ id: first.allocationId, instruction: { order: 'o-1', qty: '2' } }],
    });
    expect(evidence.history.map((h) => h.event)).toEqual(['invited', 'accepted']);
  });

  it('revoke: link becomes revoked, new allocations refuse, history stays; either side may revoke', async () => {
    const link = { orgId, clientUserId: id(client) };
    await as(admin).client.invite({ ...link, clientTag: 'VIP-1' });
    await as(client).client.accept({ orgId });
    await as(admin).allocate({ ...link, instruction: { order: 'o-1' } });
    expect(await as(admin).client.revoke(link)).toEqual({ status: 'revoked', changed: true });
    expect(await as(client).client.revoke(link)).toEqual({ status: 'revoked', changed: false });
    expect(await refusal(as(admin).allocate({ ...link, instruction: { order: 'o-2' } }))).toMatchObject({
      trpc: 'PRECONDITION_FAILED',
      code: 'identity.broker_client_revoked',
    });
    expect((await refusal(as(admin).client.invite({ ...link, clientTag: 'VIP-1' }))).code).toBe('identity.broker_client_revoked');
    expect((await refusal(as(client).client.accept({ orgId }))).code).toBe('identity.broker_client_revoked');
    const evidence = await as(client).evidence.mine({ orgId });
    expect(evidence.status).toBe('revoked');
    expect(evidence.allocations).toHaveLength(1);
    expect(evidence.history.map((h) => h.event)).toEqual(['invited', 'accepted', 'revoked']);

    // The client can also revoke on their own.
    await as(admin).client.invite({ orgId, clientUserId: id(other), clientTag: 'B' });
    expect(await as(other).client.revoke({ orgId, clientUserId: id(other) })).toEqual({ status: 'revoked', changed: true });
  });

  it('refuses a blank schedule row or no rows; versions are immutable', async () => {
    for (const bad of [[], [{ product: 'spot', rate: '' }], [{ product: '  ', rate: '0.1' }], [{ product: 'spot', rate: '1e-3' }]]) {
      expect(await refusal(as(admin).schedule.publish({ orgId, rows: bad }))).toMatchObject({
        trpc: 'BAD_REQUEST',
        code: 'identity.broker_schedule_unset',
      });
    }
    await as(admin).schedule.publish({ orgId, rows });
    await expect(db.sql`UPDATE broker_commission_schedules SET rows = '[]'::jsonb WHERE org_id = ${orgId}`).rejects.toThrow(
      /broker_schedule_immutable/,
    );
    await expect(db.sql`DELETE FROM broker_commission_schedules WHERE org_id = ${orgId}`).rejects.toThrow(/broker_schedule_immutable/);
  });

  it("a client cannot read another client's evidence; only admins write; outsiders see nothing", async () => {
    await as(admin).client.invite({ orgId, clientUserId: id(client), clientTag: 'VIP-1' });
    expect(await refusal(as(other).evidence.mine({ orgId }))).toMatchObject({
      trpc: 'NOT_FOUND',
      code: 'identity.broker_client_not_found',
    });
    expect((await refusal(as(trader).client.invite({ orgId, clientUserId: id(other), clientTag: 'X' }))).code).toBe(
      'identity.broker_admin_required',
    );
    expect((await refusal(as(trader).schedule.publish({ orgId, rows }))).code).toBe('identity.broker_admin_required');
    expect((await refusal(as(trader).client.revoke({ orgId, clientUserId: id(client) }))).code).toBe('identity.broker_admin_required');
    expect((await refusal(as(other).client.invite({ orgId, clientUserId: id(trader), clientTag: 'X' }))).trpc).toBe('NOT_FOUND');
    expect((await refusal(as(admin).client.invite({ orgId, clientUserId: id(admin), clientTag: 'X' }))).code).toBe(
      'identity.broker_client_self',
    );
    expect((await refusal(as(admin).client.invite({ orgId, clientUserId: randomUUID(), clientTag: 'X' }))).code).toBe(
      'identity.broker_client_not_found',
    );
    expect((await refusal(as(admin).client.invite({ orgId, clientUserId: id(other), clientTag: ' ' }))).code).toBe(
      'identity.broker_tag_invalid',
    );
    // A broker cannot attach a client by accepting for them: accept only ever acts on the caller's own invitation.
    expect((await refusal(as(admin).client.accept({ orgId }))).code).toBe('identity.broker_client_not_found');
    expect((await refusal(as(admin).allocate({ orgId, clientUserId: id(client), instruction: {} }))).code).toBe(
      'identity.broker_instruction_invalid',
    );
    expect((await refusal(as(admin).allocate({ orgId, clientUserId: id(other), instruction: { a: 1 } }))).code).toBe(
      'identity.broker_client_not_found',
    );
  });
}
