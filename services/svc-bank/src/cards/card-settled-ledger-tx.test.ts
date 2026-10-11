/**
 * A settled card movement names the ledger transaction that moved the value.
 *
 * Raw SQL on purpose. The service writes the status and the transaction id in
 * one statement, so a hole that only the database can refuse never shows up
 * through CardService. The check is the public seam: Postgres rejects the row.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const CONSTRAINT_MIGRATION = '0017_card_settled_needs_ledger_tx.sql';

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) throw new Error('TEST_DATABASE_URL is unset');

const HOLDER = '11111111-1111-4111-8111-111111111111';

const AUTH_SETTLED_HOLD = 'card_authorizations_settled_approved_has_hold_ck';
const SETTLEMENT_SETTLED_TX = 'card_settlements_settled_has_tx_ck';
const CASHBACK_SETTLED_TX = 'card_cashback_settled_has_tx_ck';

function forwardMigrations(except?: string): string[] {
  return readdirSync(drizzle)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== except)
    .sort()
    .map((f) => readFileSync(join(drizzle, f), 'utf8'));
}

async function insertCard(db: TestDatabase): Promise<string> {
  const rows = await db.sql<Array<{ id: string }>>`
    INSERT INTO bank.cards (
      user_id, asset_id, settlement_asset_id, issuer, issuer_ref, pan_tail, per_authorization_limit
    ) VALUES (
      ${HOLDER}, 'USDT', 'USDT', 'card-sim', ${`ref-${randomUUID()}`}, '4242', '1000.00'
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

async function insertPendingApproval(db: TestDatabase, cardId: string, authorizationRef: string): Promise<string> {
  const rows = await db.sql<Array<{ id: string }>>`
    INSERT INTO bank.card_authorizations (card_id, authorization_ref, amount, decision, status)
    VALUES (${cardId}, ${authorizationRef}, '40.00', 'approved', 'pending')
    RETURNING id
  `;
  return rows[0]!.id;
}

/** A resolved insert is a stored row. The check we want answers 23514. */
async function storedOrRejected(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => ({ code: 'accepted' }),
    (err: unknown) => err,
  );
}

describe('a settled card movement requires its ledger transaction', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: forwardMigrations() });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('refuses a settled approval, settlement, and cashback that omit the ledger transaction', async () => {
    const cardId = await insertCard(db);
    const openId = await insertPendingApproval(db, cardId, 'open-approved');

    const bareApproval = await storedOrRejected(db.sql`
      INSERT INTO bank.card_authorizations (
        card_id, authorization_ref, amount, decision, status, hold_ledger_tx_id
      ) VALUES (
        ${cardId}, 'settled-approved-bare', '25.50', 'approved', 'settled', NULL
      )
    `);
    expect(bareApproval, 'settled approved authorization stored hold_ledger_tx_id null').toMatchObject({
      code: '23514',
    });
    expect((bareApproval as Error).message).toContain(AUTH_SETTLED_HOLD);

    const bareSettlement = await storedOrRejected(db.sql`
      INSERT INTO bank.card_settlements (
        authorization_id, sequence, kind, amount, status, ledger_tx_id
      ) VALUES (
        ${openId}, 0, 'capture', '25.50', 'settled', NULL
      )
    `);
    expect(bareSettlement, 'settled card_settlements row stored ledger_tx_id null').toMatchObject({
      code: '23514',
    });
    expect((bareSettlement as Error).message).toContain(SETTLEMENT_SETTLED_TX);

    const bareCashback = await storedOrRejected(db.sql`
      INSERT INTO bank.card_cashback (
        authorization_id, rate_bps, amount, status, ledger_tx_id
      ) VALUES (
        ${openId}, 150, '0.40', 'settled', NULL
      )
    `);
    expect(bareCashback, 'settled card_cashback row stored ledger_tx_id null').toMatchObject({
      code: '23514',
    });
    expect((bareCashback as Error).message).toContain(CASHBACK_SETTLED_TX);

    // A decline still omits a transaction, including once it is settled.
    await db.sql`
      INSERT INTO bank.card_authorizations (
        card_id, authorization_ref, amount, decision, decline_code, status, hold_ledger_tx_id
      ) VALUES (
        ${cardId}, 'settled-decline', '15.00', 'declined', 'bank.card_not_active', 'settled', NULL
      )
    `;

    // The claim written before the hold posts is still pending and still null.
    await db.sql`
      INSERT INTO bank.card_authorizations (
        card_id, authorization_ref, amount, decision, status, hold_ledger_tx_id
      ) VALUES (
        ${cardId}, 'pending-approved', '10.00', 'approved', 'pending', NULL
      )
    `;

    await db.sql`
      INSERT INTO bank.card_authorizations (
        card_id, authorization_ref, amount, decision, status, hold_ledger_tx_id
      ) VALUES (
        ${cardId}, 'settled-approved', '25.50', 'approved', 'settled', 'ledger-tx-hold-1'
      )
    `;

    await db.sql`
      INSERT INTO bank.card_settlements (
        authorization_id, sequence, kind, amount, status, ledger_tx_id
      ) VALUES (
        ${openId}, 0, 'capture', '25.50', 'settled', 'ledger-tx-capture-1'
      )
    `;
    await db.sql`
      INSERT INTO bank.card_settlements (
        authorization_id, sequence, kind, amount, status, ledger_tx_id
      ) VALUES (
        ${openId}, 1, 'reversal', '1.00', 'pending', NULL
      )
    `;
    await db.sql`
      INSERT INTO bank.card_settlements (
        authorization_id, sequence, kind, amount, status, rejection_code, ledger_tx_id
      ) VALUES (
        ${openId}, 2, 'reversal', '1.00', 'rejected', 'bank.post_failed', NULL
      )
    `;

    await db.sql`
      INSERT INTO bank.card_cashback (
        authorization_id, rate_bps, amount, status, ledger_tx_id
      ) VALUES (
        ${openId}, 150, '0.40', 'settled', 'ledger-tx-cashback-1'
      )
    `;

    const otherId = await insertPendingApproval(db, cardId, 'open-for-unpaid-reward');
    await db.sql`
      INSERT INTO bank.card_cashback (
        authorization_id, rate_bps, amount, status, rejection_code, ledger_tx_id
      ) VALUES (
        ${otherId}, 150, '0.40', 'rejected', 'bank.cashback_pot_unfunded', NULL
      )
    `;
    await db.sql`
      INSERT INTO bank.card_cashback (
        authorization_id, rate_bps, amount, status, ledger_tx_id
      ) VALUES (
        ${await insertPendingApproval(db, cardId, 'open-for-pending-reward')}, 150, '0.40', 'pending', NULL
      )
    `;
  });
});

describe('an existing settled row with no ledger transaction makes the migration raise', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({
      service: 'bank',
      url: DB_URL,
      migrations: forwardMigrations(CONSTRAINT_MIGRATION),
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('raises and leaves the violating rows untouched', async () => {
    const migrationPath = join(drizzle, CONSTRAINT_MIGRATION);
    expect(existsSync(migrationPath), `${CONSTRAINT_MIGRATION} is the check`).toBe(true);
    const migrationSql = readFileSync(migrationPath, 'utf8');
    const statements = migrationSql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);

    const cardId = await insertCard(db);
    const openId = await insertPendingApproval(db, cardId, 'already-open');

    const [approval] = await db.sql<Array<{ id: string }>>`
      INSERT INTO bank.card_authorizations (
        card_id, authorization_ref, amount, decision, status, hold_ledger_tx_id
      ) VALUES (
        ${cardId}, 'already-settled-bare', '25.50', 'approved', 'settled', NULL
      )
      RETURNING id
    `;
    const [settlement] = await db.sql<Array<{ id: string }>>`
      INSERT INTO bank.card_settlements (
        authorization_id, sequence, kind, amount, status, ledger_tx_id
      ) VALUES (
        ${openId}, 0, 'capture', '25.50', 'settled', NULL
      )
      RETURNING id
    `;
    const [cashback] = await db.sql<Array<{ id: string }>>`
      INSERT INTO bank.card_cashback (
        authorization_id, rate_bps, amount, status, ledger_tx_id
      ) VALUES (
        ${openId}, 150, '0.40', 'settled', NULL
      )
      RETURNING id
    `;

    const raised = await storedOrRejected(db.sql.unsafe(migrationSql));
    expect(raised, 'migration stored a settled row that still has no ledger transaction').toMatchObject({
      code: '23514',
    });

    const approvals = await db.sql<Array<{ status: string; hold_ledger_tx_id: string | null }>>`
      SELECT status, hold_ledger_tx_id FROM bank.card_authorizations WHERE id = ${approval!.id}
    `;
    expect(approvals).toEqual([{ status: 'settled', hold_ledger_tx_id: null }]);

    const settlements = await db.sql<Array<{ status: string; ledger_tx_id: string | null }>>`
      SELECT status, ledger_tx_id FROM bank.card_settlements WHERE id = ${settlement!.id}
    `;
    expect(settlements).toEqual([{ status: 'settled', ledger_tx_id: null }]);

    const rewards = await db.sql<Array<{ status: string; ledger_tx_id: string | null }>>`
      SELECT status, ledger_tx_id FROM bank.card_cashback WHERE id = ${cashback!.id}
    `;
    expect(rewards).toEqual([{ status: 'settled', ledger_tx_id: null }]);

    // The failed migration did not leave the check behind.
    await db.sql`
      INSERT INTO bank.card_authorizations (
        card_id, authorization_ref, amount, decision, status, hold_ledger_tx_id
      ) VALUES (
        ${cardId}, 'still-unconstrained', '10.00', 'approved', 'settled', NULL
      )
    `;
  });
});
