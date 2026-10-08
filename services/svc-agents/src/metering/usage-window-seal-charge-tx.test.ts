/**
 * A sealed usage window keeps the ledger transaction id it recorded.
 *
 * `usage_windows_seal_once` already refused a second write of sealed_at,
 * charged_amount, or charge_key. charge_tx_id was not in that comparison, so
 * a later update could point the window at a different ledger transaction or
 * clear the id. The id is a ledger transaction id, not a balance.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const RECORDED_TX = 'ledger-tx-recorded';
const OTHER_TX = 'ledger-tx-other';
const OPEN_TX = 'ledger-tx-while-unsealed';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SESSION_OPEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
/** Decimal string. The column is numeric; this test never parses it as a number. */
const SEALED_AMOUNT = '1.250000000000000000';

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('usage window seal charge_tx_id (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const schema = `l947_seal_${process.pid}_${Date.now()}`;
  const sql = postgres(URL, {
    max: 1,
    connection: { search_path: `${schema},public`, application_name: 'svc-agents-seal-charge-tx' },
    onnotice: () => undefined,
  });

  const migrations = readdirSync(drizzleDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

  async function chargeTxId(sessionId: string, windowId: string): Promise<string | null> {
    const rows = await sql<Array<{ charge_tx_id: string | null }>>`
      SELECT charge_tx_id FROM usage_windows
       WHERE session_id = ${sessionId} AND window_id = ${windowId}
    `;
    return rows[0]?.charge_tx_id ?? null;
  }

  async function insertSession(id: string) {
    await sql`
      INSERT INTO agent_sessions (id, user_id, agent_id, guardrail, guardrail_version)
      VALUES (${id}, 'user-a', 'probe', ${sql.json({ limits: {} })}, 1)
    `;
  }

  beforeAll(async () => {
    await assertTestDatabase(sql, 'usage-window-seal-charge-tx');
    await sql.unsafe(`CREATE SCHEMA "${schema}"`);
    for (const migration of migrations) {
      await sql.unsafe(rewriteSchemaSql(migration, 'agents', schema));
    }
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await sql.end({ timeout: 5 });
  });

  it('refuses a change or a clear of charge_tx_id after the window is sealed', async () => {
    await insertSession(SESSION);
    await sql`
      INSERT INTO usage_windows (session_id, window_id)
      VALUES (${SESSION}, 'w-sealed')
    `;
    await sql`
      UPDATE usage_windows
         SET sealed_at = now(),
             charged_amount = ${SEALED_AMOUNT}::numeric,
             charge_key = ${'agent.usage:w-sealed'},
             charge_tx_id = ${RECORDED_TX}
       WHERE session_id = ${SESSION} AND window_id = 'w-sealed'
    `;
    expect(await chargeTxId(SESSION, 'w-sealed')).toBe(RECORDED_TX);

    // Writing the same id is not a change.
    await sql`
      UPDATE usage_windows
         SET charge_tx_id = ${RECORDED_TX}
       WHERE session_id = ${SESSION} AND window_id = 'w-sealed'
    `;
    expect(await chargeTxId(SESSION, 'w-sealed')).toBe(RECORDED_TX);

    await expect(
      sql`
        UPDATE usage_windows
           SET charge_tx_id = ${OTHER_TX}
         WHERE session_id = ${SESSION} AND window_id = 'w-sealed'
      `,
    ).rejects.toMatchObject({ code: '23001' });
    expect(await chargeTxId(SESSION, 'w-sealed')).toBe(RECORDED_TX);

    await expect(
      sql`
        UPDATE usage_windows
           SET charge_tx_id = NULL
         WHERE session_id = ${SESSION} AND window_id = 'w-sealed'
      `,
    ).rejects.toMatchObject({ code: '23001' });
    expect(await chargeTxId(SESSION, 'w-sealed')).toBe(RECORDED_TX);

    // Same refusal the amount already had.
    await expect(
      sql`
        UPDATE usage_windows
           SET charged_amount = ${'9.000000000000000000'}::numeric
         WHERE session_id = ${SESSION} AND window_id = 'w-sealed'
      `,
    ).rejects.toMatchObject({ code: '23001' });
    expect(await chargeTxId(SESSION, 'w-sealed')).toBe(RECORDED_TX);
  });

  it('lets an unsealed window set charge_tx_id', async () => {
    await insertSession(SESSION_OPEN);
    await sql`
      INSERT INTO usage_windows (session_id, window_id)
      VALUES (${SESSION_OPEN}, 'w-open')
    `;

    await sql`
      UPDATE usage_windows
         SET sealed_at = now(),
             charged_amount = ${SEALED_AMOUNT}::numeric,
             charge_key = ${'agent.usage:w-open'},
             charge_tx_id = ${OPEN_TX}
       WHERE session_id = ${SESSION_OPEN} AND window_id = 'w-open'
    `;
    expect(await chargeTxId(SESSION_OPEN, 'w-open')).toBe(OPEN_TX);
  });

  it('records a missing ledger id once after seal, then keeps it', async () => {
    // Settlement seals the amount before the ledger post. The id is null until
    // that post lands. Filling it is the record step; changing or clearing it
    // afterwards is the refusal.
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
    await insertSession(sessionId);
    await sql`
      INSERT INTO usage_windows (session_id, window_id)
      VALUES (${sessionId}, 'w-pending')
    `;
    await sql`
      UPDATE usage_windows
         SET sealed_at = now(),
             charged_amount = ${SEALED_AMOUNT}::numeric,
             charge_key = ${'agent.usage:w-pending'},
             charge_tx_id = NULL
       WHERE session_id = ${sessionId} AND window_id = 'w-pending'
    `;

    await sql`
      UPDATE usage_windows
         SET charge_tx_id = ${RECORDED_TX}
       WHERE session_id = ${sessionId} AND window_id = 'w-pending'
    `;
    expect(await chargeTxId(sessionId, 'w-pending')).toBe(RECORDED_TX);

    await expect(
      sql`
        UPDATE usage_windows
           SET charge_tx_id = ${OTHER_TX}
         WHERE session_id = ${sessionId} AND window_id = 'w-pending'
      `,
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      sql`
        UPDATE usage_windows
           SET charge_tx_id = NULL
         WHERE session_id = ${sessionId} AND window_id = 'w-pending'
      `,
    ).rejects.toMatchObject({ code: '23001' });
    expect(await chargeTxId(sessionId, 'w-pending')).toBe(RECORDED_TX);
  });
}
