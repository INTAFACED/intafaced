import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { SqlCheckBook, VerificationChecks, type RecordOwners } from './verification-checks.js';
import { PostgresSupportStore } from './store.js';
import { SupportService } from './support-service.js';

/**
 * The balance disclosure gate on the real tables (J-support-public-20 #2): two operators recording one record at once leave
 * one check, a refused check writes no row, the gate counts rows, and the table refuses update and delete.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'));

const CUSTOMER = '5c0e0e03-1111-4111-8111-111111111111';
const OP = '5c0e0e03-3333-4333-8333-333333333333';
const OTHER_OP = '5c0e0e03-4444-4444-8444-444444444444';
const W1 = '5c0e0e03-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D1 = '5c0e0e03-cccc-4ccc-8ccc-cccccccccccc';
const THEIRS = '5c0e0e03-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const available = await postgresAvailable(ADMIN_URL);
const db: TestDatabase | null = available ? await createTestDatabase({ service: 'support', url: ADMIN_URL, migrations: MIGRATIONS }) : null;
const sql = db?.sql ?? null;
if (sql) await assertTestDatabase(sql, 'svc-support verification-checks.pg.test');

afterAll(async () => {
  await db?.drop();
}, 30_000);

const owners: RecordOwners = { 'svc-pay': { owns: async ({ recordId, userId }) => userId === CUSTOMER && recordId !== THEIRS } };

describe.skipIf(!available)('the balance disclosure gate, on Postgres', () => {
  const desk = (conn = sql!) => {
    const store = new PostgresSupportStore(conn);
    return { store, checks: new VerificationChecks(new SqlCheckBook(conn), new SupportService(store), owners) };
  };
  const ticket = () => desk().store.createTicket({ userId: CUSTOMER, category: 'deposit_withdraw', subject: 'TEST', body: 'TEST' });
  const count = async (ticketId: string) =>
    (await sql!<{ n: number }[]>`SELECT count(*)::int AS n FROM support.ticket_verification_checks WHERE ticket_id = ${ticketId}`)[0]!.n;
  const owned = (ticketId: string, recordKind: 'withdrawal' | 'deposit' | 'order', recordId: string) =>
    ({ ticketId, kind: 'owned_record', recordKind, recordId }) as const;

  it('two operators recording the same record at once leave one check, and the gate stays shut', async () => {
    const { id } = await ticket();
    const second = postgres(db!.url, { max: 1, onnotice: () => undefined });
    try {
      const [a, b] = await Promise.all([
        desk().checks.record(OP, owned(id, 'withdrawal', W1)),
        desk(second).checks.record(OTHER_OP, owned(id, 'withdrawal', W1)),
      ]);
      expect(a).toEqual(b);
      expect(await count(id)).toBe(1);
      await expect(desk().checks.customerBalance(OP, id)).rejects.toMatchObject({ code: 'support.verification_checks_required' });
    } finally {
      await second.end({ timeout: 5 });
    }
  });

  it('a refused check writes nothing; two recorded checks open the gate onto a read that refuses', async () => {
    const { id } = await ticket();
    const { checks } = desk();
    await expect(checks.record(OP, owned(id, 'deposit', THEIRS))).rejects.toMatchObject({ code: 'support.verification_check_not_owned' });
    await expect(checks.record(OP, owned(id, 'order', W1))).rejects.toMatchObject({ code: 'support.verification_check_owner_unwired' });
    expect(await count(id)).toBe(0);
    await checks.record(OP, owned(id, 'withdrawal', W1));
    await checks.record(OP, owned(id, 'deposit', D1));
    expect(await count(id)).toBe(2);
    await expect(checks.customerBalance(OP, id)).rejects.toMatchObject({ code: 'support.balance_read_unwired' });
  });

  it('a check cannot be changed or removed, and names a real ticket and a known kind', async () => {
    const { id } = await ticket();
    await desk().checks.record(OP, owned(id, 'withdrawal', W1));
    await expect(sql!`UPDATE support.ticket_verification_checks SET record_id = ${THEIRS} WHERE ticket_id = ${id}`).rejects.toThrow(
      /append-only/,
    );
    await expect(sql!`DELETE FROM support.ticket_verification_checks WHERE ticket_id = ${id}`).rejects.toThrow(/append-only/);
    await expect(
      sql!`INSERT INTO support.ticket_verification_checks (ticket_id, kind, record_kind, record_id, recorded_by, recorded_at)
           VALUES (${id}, 'operator_says_so', 'deposit', ${D1}, ${OP}, now())`,
    ).rejects.toThrow(/check/i);
    await expect(
      sql!`INSERT INTO support.ticket_verification_checks (ticket_id, kind, record_kind, record_id, recorded_by, recorded_at)
           VALUES (${THEIRS}, 'owned_record', 'deposit', ${D1}, ${OP}, now())`,
    ).rejects.toThrow(/foreign key/i);
    expect(await count(id)).toBe(1);
  });
});
