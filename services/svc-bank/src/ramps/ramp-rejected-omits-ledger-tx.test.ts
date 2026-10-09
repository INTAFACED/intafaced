/**
 * A rejected onramp may still have ledger_tx_id set, and a rejected offramp
 * may still have settle_ledger_tx_id or hold_ledger_tx_id set.
 *
 * 0004 stays as applied. Settled onramps still require ledger_tx_id, and
 * settled offramps still require both hold and settle ids. 0025 refuses a
 * rejected onramp that names a ledger posting, and a rejected offramp that
 * names a hold or settle posting. release_ledger_tx_id may be set only when
 * the offramp is rejected. The fixture, including the down migration, runs
 * in a transaction and rolls back. No row is updated or deleted.
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

const AMOUNT = '1.00';
const USER = 'l1106-user';
const CODE = 'ledger.insufficient_funds';
const ONRAMP_OMITS = 'ramp_onramps_rejected_omits_ledger_tx_ck';
const ONRAMP_SETTLED = 'ramp_onramps_settled_has_tx_ck';
const OFFRAMP_OMITS = 'ramp_offramps_rejected_omits_ledger_tx_ck';
const OFFRAMP_RELEASE = 'ramp_offramps_release_only_when_rejected_ck';

type Tx = postgres.TransactionSql;
type RampStatus = 'pending' | 'settled' | 'rejected';

interface OnrampStored {
  status: string;
  ledger_tx_id: string | null;
  rejection_code: string | null;
  amount: string;
}

interface OfframpStored {
  status: string;
  hold_ledger_tx_id: string | null;
  settle_ledger_tx_id: string | null;
  release_ledger_tx_id: string | null;
  rejection_code: string | null;
  amount: string;
}

class RollBack extends Error {
  constructor() {
    super('roll back rejected-ramp fixture');
  }
}

function sqlFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
}

function migrationPair(): { up: string; down: string } {
  const names = readdirSync(drizzleDir);
  const up = names.find((name) => /^0025_.*\.sql$/.test(name) && !name.endsWith('.down.sql'));
  const down = names.find((name) => /^0025_.*\.down\.sql$/.test(name));
  return { up: up ? readFileSync(join(drizzleDir, up), 'utf8') : '', down: down ? readFileSync(join(drizzleDir, down), 'utf8') : '' };
}

let sql: postgres.Sql;
let seq = 0;

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

function nextRef(kind: string): string {
  seq += 1;
  return `l1106-${kind}-${seq}`;
}

function insertOnramp(
  tx: Tx,
  input: { status: RampStatus; ledgerTxId: string | null; rejectionCode: string | null },
): Promise<OnrampStored[]> {
  return tx<OnrampStored[]>`
    INSERT INTO bank.ramp_onramps (
      user_id, asset_id, amount, rail, rail_ref, credited_by, status, ledger_tx_id, rejection_code
    ) VALUES (
      ${USER}, ${'USDT'}, ${AMOUNT}::numeric, ${'crypto-ledger'}, ${nextRef('on')}, ${'l1106'},
      ${input.status}, ${input.ledgerTxId}, ${input.rejectionCode}
    )
    RETURNING status, ledger_tx_id, rejection_code, amount::text AS amount
  `;
}

function insertOfframp(
  tx: Tx,
  input: {
    status: RampStatus;
    holdLedgerTxId: string | null;
    settleLedgerTxId: string | null;
    releaseLedgerTxId: string | null;
    rejectionCode: string | null;
  },
): Promise<OfframpStored[]> {
  return tx<OfframpStored[]>`
    INSERT INTO bank.ramp_offramps (
      user_id, asset_id, amount, rail, destination_ref, client_ref, status,
      hold_ledger_tx_id, settle_ledger_tx_id, release_ledger_tx_id, rejection_code
    ) VALUES (
      ${USER}, ${'USDT'}, ${AMOUNT}::numeric, ${'crypto-ledger'}, ${'dest-l1106'}, ${nextRef('off')},
      ${input.status}, ${input.holdLedgerTxId}, ${input.settleLedgerTxId}, ${input.releaseLedgerTxId},
      ${input.rejectionCode}
    )
    RETURNING
      status,
      hold_ledger_tx_id,
      settle_ledger_tx_id,
      release_ledger_tx_id,
      rejection_code,
      amount::text AS amount
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

function expectInstructionAmount(amount: string) {
  expect(typeof amount).toBe('string');
  expect(amount.startsWith('1')).toBe(true);
}

describe('a rejected ramp omits the hold and settle posting', () => {
  it('refuses a rejected ledger id, stores a release id only on a rejected offramp, and still requires settled postings', async () => {
    const { up, down } = migrationPair();

    try {
      await sql.begin(async (tx) => {
        if (down) await tx.unsafe(down);
        if (up) await tx.unsafe(up);

        expect(
          await rejected(tx, (sp) => insertOnramp(sp, { status: 'rejected', ledgerTxId: 'l1106-on-tx', rejectionCode: CODE })),
          'a rejected onramp with a ledger id is refused',
        ).toMatchObject({ code: '23514', constraint_name: ONRAMP_OMITS });

        const rejectedOnramp = (
          await insertOnramp(tx, { status: 'rejected', ledgerTxId: null, rejectionCode: CODE })
        )[0]!;
        expect(rejectedOnramp.status).toBe('rejected');
        expect(rejectedOnramp.ledger_tx_id).toBeNull();
        expect(rejectedOnramp.rejection_code).toBe(CODE);
        expectInstructionAmount(rejectedOnramp.amount);

        expect(
          await rejected(tx, (sp) => insertOnramp(sp, { status: 'settled', ledgerTxId: null, rejectionCode: null })),
          'a settled onramp with a null ledger id is refused',
        ).toMatchObject({ code: '23514', constraint_name: ONRAMP_SETTLED });

        expect(
          await rejected(tx, (sp) =>
            insertOfframp(sp, {
              status: 'rejected',
              holdLedgerTxId: 'l1106-hold',
              settleLedgerTxId: null,
              releaseLedgerTxId: null,
              rejectionCode: CODE,
            }),
          ),
          'a rejected offramp with a hold id is refused',
        ).toMatchObject({ code: '23514', constraint_name: OFFRAMP_OMITS });

        expect(
          await rejected(tx, (sp) =>
            insertOfframp(sp, {
              status: 'rejected',
              holdLedgerTxId: null,
              settleLedgerTxId: 'l1106-settle',
              releaseLedgerTxId: null,
              rejectionCode: CODE,
            }),
          ),
          'a rejected offramp with a settle id is refused',
        ).toMatchObject({ code: '23514', constraint_name: OFFRAMP_OMITS });

        const released = (
          await insertOfframp(tx, {
            status: 'rejected',
            holdLedgerTxId: null,
            settleLedgerTxId: null,
            releaseLedgerTxId: 'l1106-release',
            rejectionCode: CODE,
          })
        )[0]!;
        expect(released.status).toBe('rejected');
        expect(released.hold_ledger_tx_id).toBeNull();
        expect(released.settle_ledger_tx_id).toBeNull();
        expect(released.release_ledger_tx_id).toBe('l1106-release');
        expect(typeof released.release_ledger_tx_id).toBe('string');
        expect(released.rejection_code).toBe(CODE);
        expectInstructionAmount(released.amount);

        const insufficient = (
          await insertOfframp(tx, {
            status: 'rejected',
            holdLedgerTxId: null,
            settleLedgerTxId: null,
            releaseLedgerTxId: null,
            rejectionCode: CODE,
          })
        )[0]!;
        expect(insufficient.status).toBe('rejected');
        expect(insufficient.hold_ledger_tx_id).toBeNull();
        expect(insufficient.settle_ledger_tx_id).toBeNull();
        expect(insufficient.release_ledger_tx_id).toBeNull();
        expect(insufficient.rejection_code).toBe(CODE);
        expectInstructionAmount(insufficient.amount);

        const settled = (
          await insertOfframp(tx, {
            status: 'settled',
            holdLedgerTxId: 'l1106-hold-settled',
            settleLedgerTxId: 'l1106-settle-settled',
            releaseLedgerTxId: null,
            rejectionCode: null,
          })
        )[0]!;
        expect(settled.status).toBe('settled');
        expect(settled.hold_ledger_tx_id).toBe('l1106-hold-settled');
        expect(typeof settled.hold_ledger_tx_id).toBe('string');
        expect(settled.settle_ledger_tx_id).toBe('l1106-settle-settled');
        expect(typeof settled.settle_ledger_tx_id).toBe('string');
        expect(settled.release_ledger_tx_id).toBeNull();
        expectInstructionAmount(settled.amount);

        expect(
          await rejected(tx, (sp) =>
            insertOfframp(sp, {
              status: 'settled',
              holdLedgerTxId: 'l1106-hold-settled',
              settleLedgerTxId: 'l1106-settle-settled',
              releaseLedgerTxId: 'l1106-release',
              rejectionCode: null,
            }),
          ),
          'a settled offramp with a release id is refused',
        ).toMatchObject({ code: '23514', constraint_name: OFFRAMP_RELEASE });

        expect(
          await rejected(tx, (sp) =>
            insertOfframp(sp, {
              status: 'pending',
              holdLedgerTxId: null,
              settleLedgerTxId: null,
              releaseLedgerTxId: 'l1106-release',
              rejectionCode: null,
            }),
          ),
          'a pending offramp with a release id is refused',
        ).toMatchObject({ code: '23514', constraint_name: OFFRAMP_RELEASE });

        throw new RollBack();
      });
    } catch (err) {
      if (!(err instanceof RollBack)) throw err;
    }
  }, 30_000);
});
