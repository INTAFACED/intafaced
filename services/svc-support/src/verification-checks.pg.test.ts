import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { checkDigest, SqlCheckBook, VerificationChecks, type VerificationOwners } from './verification-checks.js';
import { PostgresSupportStore } from './store.js';
import { SupportService } from './support-service.js';

/**
 * The balance disclosure gate on the real tables (J-support-public-20 #2, RC-support-public-01): two operators recording one
 * value at once leave one check, the attempts cap holds under a race, no typed value reaches a table, and both tables
 * refuse update and delete.
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

const EMAIL = 'ann@example.com';
const yes = { matches: async ({ value, userId }: { value: string; userId: string }) => userId === CUSTOMER && value !== THEIRS };
const owners: VerificationOwners = { 'svc-identity': yes, 'svc-pay': yes };

if (!available) {
  describe.skip('the balance disclosure gate (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('the balance disclosure gate, on Postgres', () => {
    const desk = (conn = sql!, attempts = 10) => {
      const store = new PostgresSupportStore(conn);
      return { store, checks: new VerificationChecks(new SqlCheckBook(conn), new SupportService(store), attempts, owners) };
    };
    const ticket = () => desk().store.createTicket({ userId: CUSTOMER, category: 'deposit_withdraw', subject: 'TEST', body: 'TEST' });
    const count = async (ticketId: string) =>
      (await sql!<{ n: number }[]>`SELECT count(*)::int AS n FROM support.ticket_verification_checks WHERE ticket_id = ${ticketId}`)[0]!.n;

    it('two operators recording the same value at once leave one check, and the gate stays shut', async () => {
      const { id } = await ticket();
      const second = postgres(db!.url, { max: 1, onnotice: () => undefined });
      try {
        const [a, b] = await Promise.all([
          desk().checks.record(OP, { ticketId: id, kind: 'email', value: EMAIL }),
          desk(second).checks.record(OTHER_OP, { ticketId: id, kind: 'email', value: EMAIL }),
        ]);
        expect(a.matched && b.matched).toBe(true);
        expect(await count(id)).toBe(1);
        await expect(desk().checks.disclose(OP, id, 'balance')).rejects.toMatchObject({
          code: 'support.verification_checks_required',
          missingKey: '1 of 2 matched',
        });
      } finally {
        await second.end({ timeout: 5 });
      }
    });

    it('the attempts cap holds when two operators race for the last attempt', async () => {
      const { id } = await ticket();
      const second = postgres(db!.url, { max: 1, onnotice: () => undefined });
      try {
        const results = await Promise.allSettled([
          desk(sql!, 1).checks.record(OP, { ticketId: id, kind: 'withdrawal_id', value: W1 }),
          desk(second, 1).checks.record(OTHER_OP, { ticketId: id, kind: 'deposit_id', value: D1 }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'support.verification_attempts_exhausted' } });
        expect(await count(id)).toBe(1);
      } finally {
        await second.end({ timeout: 5 });
      }
    });

    it('the email and a record id open the gate onto a read that refuses; a mismatch is stored unmatched; no typed value is kept', async () => {
      const { id } = await ticket();
      const { checks } = desk();
      await expect(checks.record(OP, { ticketId: id, kind: 'deposit_id', value: THEIRS })).rejects.toMatchObject({
        code: 'support.verification_mismatch',
      });
      await expect(checks.record(OP, { ticketId: id, kind: 'client_order_id', value: 'my-order-7' })).rejects.toMatchObject({
        code: 'support.disclosure_unwired',
        missingKey: 'svc-trade',
      });
      await checks.record(OP, { ticketId: id, kind: 'email', value: EMAIL });
      await checks.record(OP, { ticketId: id, kind: 'withdrawal_id', value: W1 });
      expect((await checks.list(OP, id)).checks.map((c) => [c.kind, c.matched])).toEqual(
        expect.arrayContaining([
          ['deposit_id', false],
          ['email', true],
          ['withdrawal_id', true],
        ]),
      );
      await expect(checks.disclose(OP, id, 'balance')).rejects.toMatchObject({
        code: 'support.disclosure_unwired',
        missingKey: 'svc-ledger',
      });
      const stored = JSON.stringify(await sql!`SELECT * FROM support.ticket_verification_checks WHERE ticket_id = ${id}`);
      const audit = JSON.stringify(await sql!`SELECT * FROM support.verification_audit WHERE ticket_id = ${id}`);
      for (const typed of [EMAIL, W1, THEIRS, 'my-order-7']) {
        expect(stored).not.toContain(typed);
        expect(audit).not.toContain(typed);
      }
      expect(stored).toContain(checkDigest(id, 'withdrawal_id', W1));
      const actions = await sql!<{ action: string; outcome: string; operator: string }[]>`
      SELECT action, outcome, operator FROM support.verification_audit WHERE ticket_id = ${id} ORDER BY id
    `;
      expect(actions.filter((a) => a.action === 'disclosure')).toEqual([
        { action: 'disclosure', outcome: 'support.disclosure_unwired', operator: OP },
      ]);
      expect(actions.filter((a) => a.action === 'record').map((a) => a.outcome)).toEqual([
        'support.verification_mismatch',
        'support.disclosure_unwired',
        'matched',
        'matched',
      ]);
    });

    it('a check and an audit row cannot be changed or removed, and name a real ticket and a known kind', async () => {
      const { id } = await ticket();
      await desk().checks.record(OP, { ticketId: id, kind: 'email', value: EMAIL });
      await expect(sql!`UPDATE support.ticket_verification_checks SET matched = false WHERE ticket_id = ${id}`).rejects.toThrow(
        /append-only/,
      );
      await expect(sql!`DELETE FROM support.ticket_verification_checks WHERE ticket_id = ${id}`).rejects.toThrow(/append-only/);
      await expect(sql!`UPDATE support.verification_audit SET outcome = 'matched' WHERE ticket_id = ${id}`).rejects.toThrow(/append-only/);
      await expect(sql!`DELETE FROM support.verification_audit WHERE ticket_id = ${id}`).rejects.toThrow(/append-only/);
      const digest = checkDigest(id, 'deposit_id', D1);
      await expect(
        sql!`INSERT INTO support.ticket_verification_checks (ticket_id, kind, value_digest, matched, checked_by, checked_at)
           VALUES (${id}, 'code_word', ${digest}, true, ${OP}, now())`,
      ).rejects.toThrow(/check/i);
      await expect(
        sql!`INSERT INTO support.ticket_verification_checks (ticket_id, kind, value_digest, matched, checked_by, checked_at)
           VALUES (${id}, 'deposit_id', ${D1}, true, ${OP}, now())`,
      ).rejects.toThrow(/check/i);
      await expect(
        sql!`INSERT INTO support.ticket_verification_checks (ticket_id, kind, value_digest, matched, checked_by, checked_at)
           VALUES (${THEIRS}, 'deposit_id', ${digest}, true, ${OP}, now())`,
      ).rejects.toThrow(/foreign key/i);
      expect(await count(id)).toBe(1);
    });
  });
}
