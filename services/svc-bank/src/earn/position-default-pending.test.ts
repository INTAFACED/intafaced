/**
 * An earn claim can exist before the ledger post. Accrual selects
 * `status = 'active' AND opened_at < boundary`, so a row that omits status
 * must land on `pending` or it earns before that post.
 *
 * 0000 shipped DEFAULT 'active'. 0001 added the enum value and left the
 * default. Those files stay as applied. The fixture, including the down
 * migration, runs in a transaction and rolls back, so stored rows stay as
 * they were. The runner records 0019 once and skips it after that.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = 'postgres://Nitro@127.0.0.1:5432/intafaced_test';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const USER = 'l1099-position-default';
const ASSET = 'USDT';
/** Decimal string. The column is numeric; this is not a ledger posting. */
const PRINCIPAL = '1.000000000000000000';
const OPENED_AT = new Date('2020-01-01T00:00:00.000Z');
const BOUNDARY = new Date('2026-10-09T00:00:00.000Z');

type Tx = postgres.TransactionSql;
type StatusRow = { id: string; status: string };

class RollBack extends Error {
  constructor() {
    super('roll back position-default fixture');
  }
}

function sqlFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
}

function migrationPair(): { up: string; down: string } {
  const names = readdirSync(drizzleDir);
  const up = names.find((name) => /^0019_.*\.sql$/.test(name) && !name.endsWith('.down.sql'));
  const down = names.find((name) => /^0019_.*\.down\.sql$/.test(name));
  return { up: up ? readFileSync(join(drizzleDir, up), 'utf8') : '', down: down ? readFileSync(join(drizzleDir, down), 'utf8') : '' };
}

function enumDefault(columnDefault: string): string {
  const quoted = /^'([^']*)'/.exec(columnDefault);
  if (!quoted?.[1]) throw new Error(`unparsed earn_positions.status default: ${columnDefault}`);
  return quoted[1];
}

let sql: postgres.Sql;

beforeAll(async () => {
  sql = postgres(URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS bank');
  await sql`
    CREATE TABLE IF NOT EXISTS bank.__migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  const applied = new Set((await sql<Array<{ name: string }>>`SELECT name FROM bank.__migrations`).map((row) => row.name));
  for (const file of sqlFiles()) {
    if (applied.has(file)) continue;
    await sql.unsafe(readFileSync(join(drizzleDir, file), 'utf8'));
    await sql`INSERT INTO bank.__migrations (name) VALUES (${file})`;
  }
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function positions(tx: Tx): Promise<StatusRow[]> {
  return tx<StatusRow[]>`
    SELECT id::text AS id, status::text AS status
      FROM bank.earn_positions
     ORDER BY id
  `;
}

async function statusDefault(tx: Tx): Promise<string> {
  const rows = await tx<Array<{ column_default: string }>>`
    SELECT column_default
      FROM information_schema.columns
     WHERE table_schema = 'bank'
       AND table_name = 'earn_positions'
       AND column_name = 'status'
  `;
  return enumDefault(rows[0]!.column_default);
}

async function eligibleIds(tx: Tx, poolId: string): Promise<string[]> {
  const rows = await tx<Array<{ id: string }>>`
    SELECT id::text AS id
      FROM bank.earn_positions
     WHERE pool_id = ${poolId}
       AND status = 'active'
       AND opened_at < ${BOUNDARY}
  `;
  return rows.map((row) => row.id);
}

describe('earn position status default', () => {
  it('stores an omitted status as pending and leaves stored rows alone', async () => {
    const { up, down } = migrationPair();
    try {
      await sql.begin(async (tx) => {
        const before = await positions(tx);
        const pool = await tx<Array<{ id: string }>>`
          INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps)
          VALUES (${ASSET}, 'flexible', 'l1099-default', ${'0'})
          RETURNING id::text AS id
        `;
        const poolId = pool[0]!.id;

        const seeded = await tx<StatusRow[]>`
          INSERT INTO bank.earn_positions (pool_id, user_id, asset_id, principal, opened_at, status)
          VALUES
            (${poolId}, ${USER}, ${ASSET}, ${PRINCIPAL}, ${OPENED_AT}, 'active'),
            (${poolId}, ${USER}, ${ASSET}, ${PRINCIPAL}, ${OPENED_AT}, 'pending'),
            (${poolId}, ${USER}, ${ASSET}, ${PRINCIPAL}, ${OPENED_AT}, 'closed')
          RETURNING id::text AS id, status::text AS status
        `;
        const seededActive = seeded.find((row) => row.status === 'active')!;
        const seededPending = seeded.find((row) => row.status === 'pending')!;

        if (up) await tx.unsafe(up);
        const afterDefault = await positions(tx);
        expect(afterDefault.filter((row) => before.some((stored) => stored.id === row.id))).toEqual(before);
        for (const row of seeded) {
          expect(afterDefault.find((stored) => stored.id === row.id)?.status).toBe(row.status);
        }

        const omitted = await tx<Array<{ id: string; status: string; principal: string }>>`
          INSERT INTO bank.earn_positions (pool_id, user_id, asset_id, principal, opened_at)
          VALUES (${poolId}, ${USER}, ${ASSET}, ${PRINCIPAL}, ${OPENED_AT})
          RETURNING id::text AS id, status::text AS status, principal::text AS principal
        `;
        const claim = omitted[0]!;
        expect(claim.status).toBe('pending');
        expect(typeof claim.principal).toBe('string');
        expect(claim.principal).toBe(PRINCIPAL);

        const principalColumn = await tx<Array<{ data_type: string; numeric_precision: number; numeric_scale: number }>>`
          SELECT data_type, numeric_precision, numeric_scale
            FROM information_schema.columns
           WHERE table_schema = 'bank'
             AND table_name = 'earn_positions'
             AND column_name = 'principal'
        `;
        expect(principalColumn[0]).toMatchObject({ data_type: 'numeric', numeric_precision: 38, numeric_scale: 18 });

        const beforeExplicit = await eligibleIds(tx, poolId);
        expect(beforeExplicit).toContain(seededActive.id);
        expect(beforeExplicit).not.toContain(claim.id);
        expect(beforeExplicit).not.toContain(seededPending.id);

        const explicit = await tx<Array<{ id: string; status: string }>>`
          INSERT INTO bank.earn_positions (pool_id, user_id, asset_id, principal, opened_at, status)
          VALUES (${poolId}, ${USER}, ${ASSET}, ${PRINCIPAL}, ${OPENED_AT}, 'active')
          RETURNING id::text AS id, status::text AS status
        `;
        expect(explicit[0]!.status).toBe('active');
        const afterExplicit = await eligibleIds(tx, poolId);
        expect(afterExplicit).toContain(explicit[0]!.id);
        expect(afterExplicit).not.toContain(claim.id);

        const stored = await positions(tx);
        if (down) await tx.unsafe(down);
        expect(await statusDefault(tx)).toBe('active');
        expect(await positions(tx)).toEqual(stored);

        const omittedWhileActive = await tx<Array<{ id: string; status: string }>>`
          INSERT INTO bank.earn_positions (pool_id, user_id, asset_id, principal, opened_at)
          VALUES (${poolId}, ${USER}, ${ASSET}, ${PRINCIPAL}, ${OPENED_AT})
          RETURNING id::text AS id, status::text AS status
        `;
        expect(omittedWhileActive[0]!.status).toBe('active');

        const afterDownInsert = await positions(tx);
        if (up) await tx.unsafe(up);
        expect(await positions(tx)).toEqual(afterDownInsert);
        expect(await statusDefault(tx)).toBe('pending');
        expect(afterDownInsert.find((row) => row.id === omittedWhileActive[0]!.id)?.status).toBe('active');
        expect(afterDownInsert.find((row) => row.id === claim.id)?.status).toBe('pending');

        throw new RollBack();
      });
    } catch (err) {
      if (!(err instanceof RollBack)) throw err;
    }
  }, 30_000);
});
