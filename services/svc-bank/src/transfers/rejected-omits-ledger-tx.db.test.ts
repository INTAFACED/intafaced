/**
 * A rejected firing must carry a rejection code and must not point at a
 * ledger posting.
 *
 * `transfer_executions_rejected_has_code_ck` (0000) requires the code and
 * says nothing about `ledger_tx_id`. A rejected row can still name a posting.
 * `transfer_executions_settled_has_tx_ck` is unchanged: settled still needs
 * a ledger id and settled_at.
 *
 * Raw SQL through the house test helper. The guard is worthless if only the
 * TypeScript path is checked.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db/testing';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'bank', schema));

const URL = 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const CHECK_VIOLATION = '23514';
const USER = '11111111-1111-4111-8111-111111111111';
/** The code the standing-order path already writes when the ledger refuses. */
const REJECTION_CODE = 'ledger.insufficient_funds';
const OMITTED_LEDGER_TX = 'transfer_executions_rejected_omits_ledger_tx_ck';
const REJECTED_HAS_CODE = 'transfer_executions_rejected_has_code_ck';
const SETTLED_HAS_TX = 'transfer_executions_settled_has_tx_ck';

const db: TestDb = await createTestDb({ service: 'bank_l1098', url: URL, migrations });

afterAll(async () => {
  await db.drop();
});

let schedules = 0;

async function seedSchedule(): Promise<string> {
  const n = ++schedules;
  const spaces = await db.sql<Array<{ id: string }>>`
    INSERT INTO spaces (user_id, asset_id, kind, name)
    VALUES
      (${USER}, 'USDT', 'named', ${`From ${n}`}),
      (${USER}, 'USDT', 'named', ${`To ${n}`})
    RETURNING id
  `;
  const fromId = spaces[0]!.id;
  const toId = spaces[1]!.id;
  const [schedule] = await db.sql<Array<{ id: string }>>`
    INSERT INTO scheduled_transfers (
      user_id, asset_id, from_space_id, to_space_id, amount, cadence, starts_at, next_run_at
    ) VALUES (
      ${USER}, 'USDT', ${fromId}, ${toId}, '1'::numeric, 'monthly', now(), now()
    )
    RETURNING id
  `;
  return schedule!.id;
}

describe.sequential('a rejected transfer execution omits the ledger posting', () => {
  it('refuses a rejected firing that points at a ledger posting', async () => {
    const scheduleId = await seedSchedule();
    await expect(
      db.sql`
        INSERT INTO transfer_executions (schedule_id, occurrence, amount, status, rejection_code, ledger_tx_id)
        SELECT ${scheduleId}, 0, amount, 'rejected', ${REJECTION_CODE}, id::text
        FROM scheduled_transfers
        WHERE id = ${scheduleId}
        RETURNING id
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: OMITTED_LEDGER_TX });
  });

  it('stores a rejected firing that has a code and a null ledger tx', async () => {
    const scheduleId = await seedSchedule();
    const rows = await db.sql<
      Array<{ status: string; rejection_code: string; ledger_tx_id: string | null; amount_is_instruction: boolean }>
    >`
      INSERT INTO transfer_executions (schedule_id, occurrence, amount, status, rejection_code)
      SELECT ${scheduleId}, 0, amount, 'rejected', ${REJECTION_CODE}
      FROM scheduled_transfers
      WHERE id = ${scheduleId}
      RETURNING
        status,
        rejection_code,
        ledger_tx_id,
        (amount = '1'::numeric) AS amount_is_instruction
    `;
    expect(rows).toEqual([
      {
        status: 'rejected',
        rejection_code: REJECTION_CODE,
        ledger_tx_id: null,
        amount_is_instruction: true,
      },
    ]);
  });

  it('still refuses a rejected firing with no rejection code', async () => {
    const scheduleId = await seedSchedule();
    await expect(
      db.sql`
        INSERT INTO transfer_executions (schedule_id, occurrence, amount, status)
        SELECT ${scheduleId}, 0, amount, 'rejected'
        FROM scheduled_transfers
        WHERE id = ${scheduleId}
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: REJECTED_HAS_CODE });
  });

  it('still refuses a settled firing with no ledger id', async () => {
    const scheduleId = await seedSchedule();
    await expect(
      db.sql`
        INSERT INTO transfer_executions (schedule_id, occurrence, amount, status, settled_at)
        SELECT ${scheduleId}, 0, amount, 'settled', now()
        FROM scheduled_transfers
        WHERE id = ${scheduleId}
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: SETTLED_HAS_TX });
  });

  it('still refuses a settled firing with a ledger id and no settled_at', async () => {
    const scheduleId = await seedSchedule();
    await expect(
      db.sql`
        INSERT INTO transfer_executions (schedule_id, occurrence, amount, status, ledger_tx_id)
        SELECT ${scheduleId}, 0, amount, 'settled', id::text
        FROM scheduled_transfers
        WHERE id = ${scheduleId}
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: SETTLED_HAS_TX });
  });

  it('stores a settled firing that has a ledger id and settled_at', async () => {
    const scheduleId = await seedSchedule();
    const rows = await db.sql<Array<{ status: string; has_ledger: boolean; has_settled_at: boolean }>>`
      INSERT INTO transfer_executions (schedule_id, occurrence, amount, status, ledger_tx_id, settled_at)
      SELECT ${scheduleId}, 0, amount, 'settled', id::text, now()
      FROM scheduled_transfers
      WHERE id = ${scheduleId}
      RETURNING status, (ledger_tx_id IS NOT NULL) AS has_ledger, (settled_at IS NOT NULL) AS has_settled_at
    `;
    expect(rows).toEqual([{ status: 'settled', has_ledger: true, has_settled_at: true }]);
  });

  it('down drops only the new constraint', async () => {
    const down = rewriteSchemaSql(
      readFileSync(join(drizzle, '0018_transfer_rejected_omits_ledger_tx.down.sql'), 'utf8'),
      'bank',
      db.schema,
    );
    await db.sql.unsafe(down);

    const checks = await db.sql<Array<{ conname: string }>>`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${db.schema}
        AND t.relname = 'transfer_executions'
        AND c.contype = 'c'
    `;
    const names = checks.map((row) => row.conname);
    expect(names).not.toContain(OMITTED_LEDGER_TX);
    expect(names).toEqual(
      expect.arrayContaining([
        REJECTED_HAS_CODE,
        SETTLED_HAS_TX,
        'transfer_executions_skipped_moved_nothing_ck',
        'transfer_executions_amount_positive_ck',
        'transfer_executions_occurrence_non_negative_ck',
      ]),
    );

    const scheduleId = await seedSchedule();
    const stored = await db.sql<Array<{ id: string }>>`
      INSERT INTO transfer_executions (schedule_id, occurrence, amount, status, rejection_code, ledger_tx_id)
      SELECT ${scheduleId}, 0, amount, 'rejected', ${REJECTION_CODE}, id::text
      FROM scheduled_transfers
      WHERE id = ${scheduleId}
      RETURNING id
    `;
    expect(stored).toHaveLength(1);

    await expect(
      db.sql`
        INSERT INTO transfer_executions (schedule_id, occurrence, amount, status)
        SELECT ${scheduleId}, 1, amount, 'rejected'
        FROM scheduled_transfers
        WHERE id = ${scheduleId}
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: REJECTED_HAS_CODE });

    await expect(
      db.sql`
        INSERT INTO transfer_executions (schedule_id, occurrence, amount, status, settled_at)
        SELECT ${scheduleId}, 2, amount, 'settled', now()
        FROM scheduled_transfers
        WHERE id = ${scheduleId}
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint_name: SETTLED_HAS_TX });
  });
});
