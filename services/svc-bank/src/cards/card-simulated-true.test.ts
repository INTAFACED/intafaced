/**
 * cards.simulated can be set false. 0003 says false means a real card exists,
 * and no check keeps the flag true.
 *
 * 0003 stays as applied. 0024 refuses a new insert that sets simulated false
 * and an update that sets it false. An insert that omits simulated stores true.
 * An insert that sets simulated true stores true. Stored rows are not rewritten.
 * The fixture, including the down migration, runs in a transaction and rolls back.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.TEST_DATABASE_URL;
if (!URL) throw new Error('TEST_DATABASE_URL is unset');

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const LIMIT = '1.00';
const PAN_TAIL = '0000';
const ISSUER = 'card-sim';

type Tx = postgres.TransactionSql;

interface CardRow {
  id: string;
  simulated: boolean;
}

class RollBack extends Error {
  constructor() {
    super('roll back card-simulated fixture');
  }
}

function sqlFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
}

function migrationPair(): { up: string; down: string } {
  const names = readdirSync(drizzleDir);
  const up = names.find((name) => /^0024_.*\.sql$/.test(name) && !name.endsWith('.down.sql'));
  const down = names.find((name) => /^0024_.*\.down\.sql$/.test(name));
  return { up: up ? readFileSync(join(drizzleDir, up), 'utf8') : '', down: down ? readFileSync(join(drizzleDir, down), 'utf8') : '' };
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

async function cards(tx: Tx, ids: string[]): Promise<CardRow[]> {
  return tx<CardRow[]>`
    SELECT id::text AS id, simulated
      FROM bank.cards
     WHERE id = ANY(${ids}::uuid[])
     ORDER BY id
  `;
}

function insertOmitted(tx: Tx, issuerRef: string) {
  return tx<CardRow[]>`
    INSERT INTO bank.cards (
      user_id, asset_id, settlement_asset_id, issuer, issuer_ref, pan_tail, per_authorization_limit
    ) VALUES (
      ${'l1104-user'}, ${'USDT'}, ${'USDT'}, ${ISSUER}, ${issuerRef}, ${PAN_TAIL}, ${LIMIT}::numeric
    )
    RETURNING id::text AS id, simulated
  `;
}

function insertSimulated(tx: Tx, issuerRef: string, simulated: boolean) {
  return tx<CardRow[]>`
    INSERT INTO bank.cards (
      user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, per_authorization_limit
    ) VALUES (
      ${'l1104-user'}, ${'USDT'}, ${'USDT'}, ${ISSUER}, ${simulated}, ${issuerRef}, ${PAN_TAIL}, ${LIMIT}::numeric
    )
    RETURNING id::text AS id, simulated
  `;
}

function setSimulated(tx: Tx, id: string, simulated: boolean) {
  return tx<CardRow[]>`
    UPDATE bank.cards
       SET simulated = ${simulated}
     WHERE id = ${id}::uuid
    RETURNING id::text AS id, simulated
  `;
}

async function rejected(tx: Tx, run: (sp: Tx) => Promise<unknown>): Promise<unknown> {
  try {
    await tx.savepoint(async (sp) => {
      await run(sp);
    });
    return undefined;
  } catch (err) {
    return err;
  }
}

function expectTrue(row: CardRow) {
  expect(typeof row.simulated).toBe('boolean');
  expect(row.simulated).toBe(true);
}

describe('a card row stays simulated', () => {
  it('refuses simulated false on insert and update, and stores true when omitted or set', async () => {
    const { up, down } = migrationPair();

    try {
      await sql.begin(async (tx) => {
        if (down) await tx.unsafe(down);

        const omittedBefore = (await insertOmitted(tx, 'l1104-omit-before'))[0]!;
        expectTrue(omittedBefore);

        const explicitBefore = (await insertSimulated(tx, 'l1104-true-before', true))[0]!;
        expectTrue(explicitBefore);

        const falseBefore = (await insertSimulated(tx, 'l1104-false-before', false))[0]!;
        expect(typeof falseBefore.simulated).toBe('boolean');
        expect(falseBefore.simulated, 'simulated false stores before the check').toBe(false);

        const flipped = (await setSimulated(tx, explicitBefore.id, false))[0]!;
        expect(flipped.simulated, 'an update can set simulated false before the check').toBe(false);

        const ids = [omittedBefore.id, explicitBefore.id, falseBefore.id];
        const before = await cards(tx, ids);
        if (up) await tx.unsafe(up);
        expect(await cards(tx, ids)).toEqual(before);

        expect(await rejected(tx, (sp) => insertSimulated(sp, 'l1104-false-after', false)), 'an insert with simulated false is refused').toMatchObject({
          code: '23514',
          constraint_name: 'cards_simulated_true',
        });

        expect(await rejected(tx, (sp) => setSimulated(sp, omittedBefore.id, false)), 'an update that sets simulated false is refused').toMatchObject({
          code: '23514',
          constraint_name: 'cards_simulated_true',
        });

        const omitted = (await insertOmitted(tx, 'l1104-omit-after'))[0]!;
        expectTrue(omitted);

        const explicit = (await insertSimulated(tx, 'l1104-true-after', true))[0]!;
        expectTrue(explicit);

        const after = await cards(tx, ids);
        for (const row of before) {
          expect(after.find((stored) => stored.id === row.id)).toEqual(row);
        }

        throw new RollBack();
      });
    } catch (err) {
      if (!(err instanceof RollBack)) throw err;
    }
  }, 30_000);
});
