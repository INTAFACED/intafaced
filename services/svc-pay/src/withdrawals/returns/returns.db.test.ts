import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWithdrawalHistory } from '../history.js';
import { RETURN_BLOCKER } from './schemas.js';
import { WithdrawalReturnService } from './service.js';

/** Returned withdrawals against a real Postgres with every forward migration. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_withdrawal_returns_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const USER = '11111111-1111-4111-8111-111111111111';
const FOUNDER = 'founder-1';

describe('returned withdrawals (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let service: WithdrawalReturnService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    service = new WithdrawalReturnService({ sql: db.sql });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE pay.withdrawals RESTART IDENTITY CASCADE`;
  }, 30_000);

  let n = 0;
  async function withdrawal(status: string, amount = '40'): Promise<string> {
    n += 1;
    const [r] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, rail_ref, status)
      VALUES (${USER}, 'USDT', ${amount}::numeric, 'card-sandbox', ${db.sql.json({ kind: 'bank', ref: 'DE89370400440532013000' })},
              ${`ref-${n}`}, ${status === 'sent' ? `rail-${n}` : null}, ${status}::pay.withdrawal_status)
      RETURNING id`;
    return r!.id;
  }
  const input = (withdrawalId: string, o: Partial<{ returnRef: string; amount: string; reason: string }> = {}) => ({
    withdrawalId,
    returnRef: o.returnRef ?? `ret-${withdrawalId}`,
    amount: o.amount ?? '40',
    reason: o.reason ?? 'Beneficiary bank returned the transfer',
  });

  it('records a return of a sent withdrawal, parked with its blocker named, and books nothing', async () => {
    const id = await withdrawal('sent');
    const out = await service.record(FOUNDER, input(id));
    expect(out).toMatchObject({
      withdrawalId: id,
      state: 'parked',
      blocker: RETURN_BLOCKER,
      amount: '40.000000000000000000',
      userId: USER,
    });
    const events = await db.sql<Array<{ kind: string }>>`SELECT kind FROM pay.withdrawal_return_events WHERE withdrawal_id = ${id}`;
    expect(events.map((e) => e.kind)).toEqual(['recorded']);
  });

  it('a repeat with the same terms returns the same record and adds no event', async () => {
    const id = await withdrawal('sent');
    await service.record(FOUNDER, input(id));
    const again = await service.record(FOUNDER, input(id));
    expect(again.withdrawalId).toBe(id);
    const [counted] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.withdrawal_return_events`;
    const count = counted?.n;
    expect(count).toBe('1');
  });

  it('refuses a second return with other terms, and a reference that names another withdrawal', async () => {
    const a = await withdrawal('sent');
    const b = await withdrawal('sent');
    await service.record(FOUNDER, input(a, { returnRef: 'ret-a' }));
    await expect(service.record(FOUNDER, input(a, { returnRef: 'ret-other' }))).rejects.toMatchObject({
      code: 'withdrawal_return.already_recorded',
    });
    await expect(service.record(FOUNDER, input(a, { returnRef: 'ret-a', amount: '10' }))).rejects.toMatchObject({
      code: 'withdrawal_return.ref_differs',
    });
    await expect(service.record(FOUNDER, input(b, { returnRef: 'ret-a' }))).rejects.toMatchObject({
      code: 'withdrawal_return.ref_differs',
    });
  });

  it('only a sent withdrawal can come back; an unknown id is not found', async () => {
    for (const status of ['pending', 'held', 'failed']) {
      const id = await withdrawal(status);
      await expect(service.record(FOUNDER, input(id))).rejects.toMatchObject({ code: 'withdrawal_return.not_sent' });
    }
    await expect(service.record(FOUNDER, input('33333333-3333-4333-8333-333333333333'))).rejects.toMatchObject({
      code: 'withdrawal_return.withdrawal_not_found',
    });
  });

  it('refuses an amount above the withdrawal and a zero amount', async () => {
    const id = await withdrawal('sent', '40');
    await expect(service.record(FOUNDER, input(id, { amount: '40.000000000000000001' }))).rejects.toMatchObject({
      code: 'withdrawal_return.amount_exceeds_withdrawal',
    });
    await expect(service.record(FOUNDER, input(id, { amount: '0' }))).rejects.toMatchObject({ code: 'withdrawal_return.amount_invalid' });
    const partial = await service.record(FOUNDER, input(id, { amount: '12.5' }));
    expect(partial.amount).toBe('12.500000000000000000');
  });

  it('lists newest first with a cursor, no row twice', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await withdrawal('sent');
      ids.push(id);
      await service.record(FOUNDER, input(id));
    }
    const first = await service.list({ limit: 2 });
    const second = await service.list({ limit: 2, after: first[1]!.withdrawalId });
    const third = await service.list({ limit: 2, after: second[1]!.withdrawalId });
    const seen = [...first, ...second, ...third].map((r) => r.withdrawalId);
    expect(new Set(seen).size).toBe(5);
    expect(seen.slice().sort()).toEqual(ids.slice().sort());
  });

  it('re-credit is refused with the blocker named, and the return stays parked', async () => {
    const id = await withdrawal('sent');
    await expect(service.recredit(id)).rejects.toMatchObject({ code: 'withdrawal_return.not_found' });
    await service.record(FOUNDER, input(id));
    await expect(service.recredit(id)).rejects.toMatchObject({ code: 'withdrawal_return.recredit_unwired' });
    expect((await service.get(id)).state).toBe('parked');
  });

  it('a recorded return and its history cannot be edited or deleted', async () => {
    const id = await withdrawal('sent');
    await service.record(FOUNDER, input(id));
    await expect(db.sql`UPDATE pay.withdrawal_returns SET reason = 'x' WHERE withdrawal_id = ${id}`).rejects.toMatchObject({
      code: '23001',
    });
    await expect(db.sql`DELETE FROM pay.withdrawal_returns WHERE withdrawal_id = ${id}`).rejects.toMatchObject({ code: '23001' });
    await expect(db.sql`DELETE FROM pay.withdrawal_return_events WHERE withdrawal_id = ${id}`).rejects.toMatchObject({ code: '23001' });
  });

  it("the customer's history flags it as returned and keeps the status settled", async () => {
    const id = await withdrawal('sent');
    const other = await withdrawal('sent');
    await service.record(FOUNDER, input(id));
    const page = await createWithdrawalHistory(db.sql).search(USER, { limit: 10 });
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(id)).toMatchObject({ status: 'settled', returned: true });
    expect(byId.get(other)).toMatchObject({ status: 'settled', returned: false });
  });
});
