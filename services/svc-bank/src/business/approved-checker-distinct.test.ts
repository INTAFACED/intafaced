/**
 * L1126. 0011 lets a business_approvals row be approved with no checker, or
 * with the maker as its own checker. The account says spend at or above
 * spend_threshold needs a checker who is not the maker.
 *
 * 0029 refuses, on insert and update:
 *   - an approved row whose checker is the maker (any amount);
 *   - an approved row at or above the account's spend_threshold with no checker.
 * A blank or whitespace-only checker is not present: btrim(checker_user_id) = ''
 * is the same as NULL for that over-threshold rule. An approved row below the
 * threshold with no checker still stores: that is the single-control post the
 * service records for an under-threshold spend. Pending, rejected, and cancelled
 * rows stay unconstrained. A cancelled row may name the maker (the maker cancels
 * their own proposal). Rows already stored are not rewritten or re-checked.
 * The fixture runs in a transaction and rolls back.
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

const THRESHOLD = '100';
const OVER = '100';
const ABOVE = '101';
const UNDER = '99.5';
const MAKER = 'l1126-maker';
const CHECKER = 'l1126-checker';
const CHECK_VIOLATION = '23514';

type Tx = postgres.TransactionSql;

class RollBack extends Error {
  constructor() {
    super('roll back approved-checker fixture');
  }
}

function sqlFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
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
  // 0029 is already recorded, so the loop will not install a replaced function
  // body. Re-applying the file replaces that function and writes no product rows.
  await sql.unsafe(readFileSync(join(drizzleDir, '0029_business_approved_checker_distinct.sql'), 'utf8'));
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function openAccount(tx: Tx): Promise<string> {
  const rows = await tx<Array<{ id: string }>>`
    INSERT INTO bank.business_accounts (name, asset_id, spend_threshold)
    VALUES (${'l1126-account'}, ${'USDT'}, ${THRESHOLD}::numeric)
    RETURNING id::text AS id
  `;
  return rows[0]!.id;
}

async function insertApproval(
  tx: Tx,
  accountId: string,
  amount: string,
  status: string,
  checker: string | null,
): Promise<string> {
  const rows = await tx<Array<{ id: string }>>`
    INSERT INTO bank.business_approvals (
      account_id, maker_user_id, checker_user_id, from_space_id, to_space_id, asset_id, amount, status
    ) VALUES (
      ${accountId}::uuid, ${MAKER}, ${checker}, gen_random_uuid(), gen_random_uuid(), ${'USDT'},
      ${amount}::numeric, ${status}::bank.business_approval_status
    )
    RETURNING id::text AS id
  `;
  return rows[0]!.id;
}

async function refused(tx: Tx, write: (sp: Tx) => Promise<unknown>): Promise<unknown> {
  try {
    await tx.savepoint(async (sp) => {
      await write(sp as unknown as Tx);
    });
    return undefined;
  } catch (err) {
    return err;
  }
}

async function statusOf(tx: Tx, id: string): Promise<{ status: string; checker_user_id: string | null }> {
  const rows = await tx<Array<{ status: string; checker_user_id: string | null }>>`
    SELECT status::text AS status, checker_user_id FROM bank.business_approvals WHERE id = ${id}::uuid
  `;
  return rows[0]!;
}

describe('an approved business transfer needs a checker who is not the maker', () => {
  it('refuses self-approved and checkerless over-threshold approvals, keeps the under-threshold post', async () => {
    try {
      await sql.begin(async (tx) => {
        const accountId = await openAccount(tx);

        expect(
          await refused(tx, (sp) => insertApproval(sp, accountId, OVER, 'approved', null)),
          'an approved over-threshold row with no checker is refused',
        ).toMatchObject({ code: CHECK_VIOLATION });
        expect(
          await refused(tx, (sp) => insertApproval(sp, accountId, OVER, 'approved', MAKER)),
          'an approved row whose checker is the maker is refused',
        ).toMatchObject({ code: CHECK_VIOLATION });
        expect(
          await refused(tx, (sp) => insertApproval(sp, accountId, UNDER, 'approved', MAKER)),
          'self-approval is refused below the threshold too',
        ).toMatchObject({ code: CHECK_VIOLATION });

        const pendingId = await insertApproval(tx, accountId, OVER, 'pending', null);
        expect(
          await refused(tx, (sp) => sp`
            UPDATE bank.business_approvals SET status = 'approved', checker_user_id = ${MAKER}, decided_at = now()
             WHERE id = ${pendingId}::uuid
          `),
          'approving a pending row as the maker is refused',
        ).toMatchObject({ code: CHECK_VIOLATION });
        expect(
          await refused(tx, (sp) => sp`
            UPDATE bank.business_approvals SET status = 'approved', decided_at = now()
             WHERE id = ${pendingId}::uuid
          `),
          'approving a pending over-threshold row with no checker is refused',
        ).toMatchObject({ code: CHECK_VIOLATION });
        expect(await statusOf(tx, pendingId)).toEqual({ status: 'pending', checker_user_id: null });

        await tx`
          UPDATE bank.business_approvals SET status = 'approved', checker_user_id = ${CHECKER}, decided_at = now()
           WHERE id = ${pendingId}::uuid
        `;
        expect(await statusOf(tx, pendingId)).toEqual({ status: 'approved', checker_user_id: CHECKER });

        const underId = await insertApproval(tx, accountId, UNDER, 'approved', null);
        expect(await statusOf(tx, underId)).toEqual({ status: 'approved', checker_user_id: null });

        const cancelId = await insertApproval(tx, accountId, OVER, 'pending', null);
        await tx`
          UPDATE bank.business_approvals SET status = 'cancelled', checker_user_id = ${MAKER}, decided_at = now()
           WHERE id = ${cancelId}::uuid
        `;
        expect(await statusOf(tx, cancelId)).toEqual({ status: 'cancelled', checker_user_id: MAKER });

        throw new RollBack();
      });
    } catch (err) {
      if (!(err instanceof RollBack)) throw err;
    }
  }, 30_000);

  it('treats a blank or whitespace-only checker as absent on an over-threshold approval', async () => {
    try {
      await sql.begin(async (tx) => {
        const accountId = await openAccount(tx);

        expect(
          await refused(tx, (sp) => insertApproval(sp, accountId, OVER, 'approved', '')),
          'an approved row at the threshold with a blank checker is refused',
        ).toMatchObject({ code: CHECK_VIOLATION });
        expect(
          await refused(tx, (sp) => insertApproval(sp, accountId, ABOVE, 'approved', ' ')),
          'an approved row over the threshold with a whitespace checker is refused',
        ).toMatchObject({ code: CHECK_VIOLATION });

        const pendingAt = await insertApproval(tx, accountId, OVER, 'pending', null);
        expect(
          await refused(tx, (sp) => sp`
            UPDATE bank.business_approvals SET status = 'approved', checker_user_id = ${''}, decided_at = now()
             WHERE id = ${pendingAt}::uuid
          `),
          'approving a pending row at the threshold with a blank checker is refused',
        ).toMatchObject({ code: CHECK_VIOLATION });
        expect(await statusOf(tx, pendingAt)).toEqual({ status: 'pending', checker_user_id: null });

        const pendingAbove = await insertApproval(tx, accountId, ABOVE, 'pending', null);
        expect(
          await refused(tx, (sp) => sp`
            UPDATE bank.business_approvals SET status = 'approved', checker_user_id = ${' '}, decided_at = now()
             WHERE id = ${pendingAbove}::uuid
          `),
          'approving a pending row over the threshold with a whitespace checker is refused',
        ).toMatchObject({ code: CHECK_VIOLATION });
        expect(await statusOf(tx, pendingAbove)).toEqual({ status: 'pending', checker_user_id: null });

        const underBlank = await insertApproval(tx, accountId, UNDER, 'approved', '');
        expect(await statusOf(tx, underBlank)).toEqual({ status: 'approved', checker_user_id: '' });
        const underSpaces = await insertApproval(tx, accountId, UNDER, 'approved', ' ');
        expect(await statusOf(tx, underSpaces)).toEqual({ status: 'approved', checker_user_id: ' ' });

        const pendingBlank = await insertApproval(tx, accountId, ABOVE, 'pending', '');
        expect(await statusOf(tx, pendingBlank)).toEqual({ status: 'pending', checker_user_id: '' });
        const rejectedSpaces = await insertApproval(tx, accountId, ABOVE, 'rejected', ' ');
        expect(await statusOf(tx, rejectedSpaces)).toEqual({ status: 'rejected', checker_user_id: ' ' });
        const cancelledBlank = await insertApproval(tx, accountId, ABOVE, 'cancelled', '');
        expect(await statusOf(tx, cancelledBlank)).toEqual({ status: 'cancelled', checker_user_id: '' });

        throw new RollBack();
      });
    } catch (err) {
      if (!(err instanceof RollBack)) throw err;
    }
  }, 30_000);
});
