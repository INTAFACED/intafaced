import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * An insert that is still waiting when settlement seals the window must not
 * commit. Settlement holds the window `FOR UPDATE`, writes `charged_amount`
 * from the rows it already saw, then commits. The insert's foreign-key wait
 * ends after that commit. The row must be refused, and `charged_amount` must
 * stay the sealed total.
 *
 * Two sessions. A third connection only watches `pg_stat_activity`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WINDOW = '2026-10-07T01';
const REQUEST = 'req-overlaps-seal';
/** Decimal string. Settlement wrote this before the racing insert landed. */
const SEALED_AMOUNT = '1.250000000000000000';
const CHARGE_KEY = 'agent.usage:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:2026-10-07T01';
const INPUT_RATE = '3.000000000000000000';
const OUTPUT_RATE = '15.000000000000000000';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ service: 'agents', url: URL, migrations });
}, 30_000);

afterAll(async () => {
  await db?.drop();
});

async function waitUntilUsageInsertBlocked(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = 'l136-usage-insert'
         AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid()
    `;
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error('usage insert never waited on the settlement row lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it('refuses a usage insert that is still waiting when the window seals', async () => {
  await db.sql`
    INSERT INTO agents.agent_sessions (id, user_id, agent_id, guardrail, guardrail_version)
    VALUES (
      ${SESSION}::uuid,
      'user-l136',
      'probe',
      ${db.sql.json({ limits: {} })},
      1
    )
  `;
  await db.sql`
    INSERT INTO agents.usage_windows (session_id, window_id)
    VALUES (${SESSION}::uuid, ${WINDOW})
  `;

  const seal = postgres(db.url, {
    max: 1,
    onnotice: () => undefined,
    connection: { application_name: 'l136-usage-seal' },
  });
  const usage = postgres(db.url, {
    max: 1,
    onnotice: () => undefined,
    connection: { application_name: 'l136-usage-insert' },
  });

  let releaseSeal!: () => void;
  const sealMayCommit = new Promise<void>((resolve) => {
    releaseSeal = resolve;
  });
  let holding!: () => void;
  const sealHoldsLock = new Promise<void>((resolve) => {
    holding = resolve;
  });

  const sealDone = seal
    .begin(async (tx) => {
      await tx`
        SELECT sealed_at
          FROM agents.usage_windows
         WHERE session_id = ${SESSION}::uuid AND window_id = ${WINDOW}
         FOR UPDATE
      `;
      holding();
      await sealMayCommit;
      await tx`
        UPDATE agents.usage_windows
           SET sealed_at = now(),
               charged_amount = ${SEALED_AMOUNT}::numeric,
               charge_key = ${CHARGE_KEY}
         WHERE session_id = ${SESSION}::uuid AND window_id = ${WINDOW}
      `;
    })
    .then(
      () => ({ ok: true as const }),
      (error: { code?: string; message?: string }) => ({ ok: false as const, error }),
    );

  const insertDone = (async () => {
    await sealHoldsLock;
    return usage.begin(async (tx) => {
      await tx`
        INSERT INTO agents.usage_records (
          session_id, window_id, request_id, task, provider_id, model,
          input_tokens, output_tokens, input_price_per_million, output_price_per_million
        ) VALUES (
          ${SESSION}::uuid,
          ${WINDOW},
          ${REQUEST},
          'plan',
          'primary',
          'reasoning-lg',
          1000,
          500,
          ${INPUT_RATE}::numeric,
          ${OUTPUT_RATE}::numeric
        )
      `;
    });
  })().then(
    () => ({ ok: true as const }),
    (error: { code?: string; message?: string }) => ({ ok: false as const, error }),
  );

  try {
    await sealHoldsLock;
    await waitUntilUsageInsertBlocked();
    releaseSeal();
    const sealed = await sealDone;
    const inserted = await insertDone;

    expect(sealed.ok, sealed.ok ? '' : sealed.error.message).toBe(true);
    expect(inserted.ok).toBe(false);
    if (!inserted.ok) expect(inserted.error.code).toBe('23001');

    const records = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM agents.usage_records
       WHERE session_id = ${SESSION}::uuid AND request_id = ${REQUEST}
    `;
    expect(records[0]?.n).toBe(0);

    const windows = await db.sql<{ charged_amount: string; sealed: boolean; same: boolean }[]>`
      SELECT charged_amount::text AS charged_amount,
             sealed_at IS NOT NULL AS sealed,
             charged_amount = ${SEALED_AMOUNT}::numeric AS same
        FROM agents.usage_windows
       WHERE session_id = ${SESSION}::uuid AND window_id = ${WINDOW}
    `;
    expect(windows[0]?.sealed).toBe(true);
    expect(typeof windows[0]?.charged_amount).toBe('string');
    expect(windows[0]?.same).toBe(true);
    expect(windows[0]?.charged_amount).toBe(SEALED_AMOUNT);
  } finally {
    releaseSeal();
    await Promise.allSettled([sealDone, insertDone]);
    await Promise.all([seal.end({ timeout: 2 }), usage.end({ timeout: 2 })]);
  }
}, 20_000);
