import type { Sql } from 'postgres';

/**
 * TEST KIT for 0023 (journal immutability + balanced-at-commit).
 *
 * Production never disables these triggers except through the documented
 * break-glass procedure (README, "Break-glass: the journal triggers"). Tests
 * that need to do what the guards forbid use the same mechanism, on their own
 * throwaway schema, and put the triggers back:
 *
 *   · reset the book between cases (TRUNCATE),
 *   · tamper with a row on purpose, to prove verifyChain / reconcile notice,
 *   · seed one-sided fixture entries that a raw-SQL test needs and that the
 *     balance trigger would (correctly) refuse.
 *
 * Statements are unqualified: the test connection's search_path is the test
 * schema, exactly like the test SQL itself.
 *
 * Excluded from the production build (tsconfig.json), included in the test
 * typecheck.
 */

type Guard = 'update' | 'truncate' | 'balance';

const GUARD_TRIGGERS: Record<Guard, ReadonlyArray<readonly [table: string, trigger: string]>> = {
  update: [
    ['ledger_entries', 'ledger_entries_immutable'],
    ['ledger_tx', 'ledger_tx_immutable'],
  ],
  truncate: [
    ['ledger_entries', 'ledger_entries_no_truncate'],
    ['ledger_tx', 'ledger_tx_no_truncate'],
    // 0029: the metadata change record has a foreign key to `accounts`, so a reset's `accounts ... CASCADE` reaches it.
    ['account_metadata_changes', 'account_metadata_changes_no_truncate'],
  ],
  balance: [['ledger_entries', 'ledger_entries_tx_must_balance']],
};

/** Run `fn` with the named guard families disabled, then restore them. */
export async function withJournalGuardsOff<T>(sql: Sql, guards: readonly Guard[], fn: () => Promise<T>): Promise<T> {
  const triggers = guards.flatMap((g) => GUARD_TRIGGERS[g]);
  for (const [table, trigger] of triggers) await sql.unsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  try {
    return await fn();
  } finally {
    for (const [table, trigger] of triggers) await sql.unsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
  }
}

/** Reset the book: `TRUNCATE <tables>` with the TRUNCATE guards lifted for that one statement. */
export function truncateBook(sql: Sql, tablesList: string): Promise<unknown> {
  return withJournalGuardsOff(sql, ['truncate'], () => sql.unsafe(`TRUNCATE ${tablesList}`));
}

/** Leave the balance-at-commit trigger off for a file whose raw fixtures insert one-sided entries on purpose. */
export async function disableBalanceTrigger(sql: Sql): Promise<void> {
  for (const [table, trigger] of GUARD_TRIGGERS.balance) await sql.unsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
}
