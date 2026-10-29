import type { Sql } from 'postgres';
import {
  ledgerTransactionsExistInputSchema,
  ledgerTransactionsExistSchema,
  type LedgerTransactionsExist,
} from '@intafaced/contracts/ledger-reconciliation';

/**
 * Which asked transaction ids name a booked transaction (OPS-reconciliation-04). Ids only, in the order asked, each
 * once. The input is parsed here, so a malformed id is a ZodError (a 400) and never reaches the database.
 */
export async function transactionsExist(sql: Sql, input: unknown): Promise<LedgerTransactionsExist> {
  const { txIds } = ledgerTransactionsExistInputSchema.parse(input);
  const asked = [...new Set(txIds.map((id) => id.toLowerCase()))];
  const rows = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM ledger_tx WHERE id = ANY(${asked}::uuid[])`;
  const booked = new Set(rows.map((row) => row.id));
  return ledgerTransactionsExistSchema.parse({ found: asked.filter((id) => booked.has(id)) });
}
