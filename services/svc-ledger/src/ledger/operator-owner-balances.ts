import type { Sql } from 'postgres';
import { z } from 'zod';
import { formatAmount, type Balance } from '@intafaced/ledger-client';

/**
 * Operator account browser, first part (OPS-ledger-desk-01, ops-console-ledger-desk-002): every balance an owner holds,
 * for a founder session with `admin:treasury` (second factor required).
 *
 * The spec's security row: "A read of a customer account detail writes an access entry (actor, target, time)." So the
 * access row is written FIRST, in `operator_access_log` (append-only, 0024). If it cannot be written the read is
 * refused: there is no unaudited path to an owner's balances. Amounts leave as decimal strings.
 */

export const OWNER_TYPES = ['user', 'subaccount', 'module', 'house', 'treasury'] as const;

export const operatorOwnerBalancesInputSchema = z
  .object({ ownerType: z.enum(OWNER_TYPES), ownerId: z.string().trim().min(1).max(128) })
  .strict();
export type OperatorOwnerBalancesInput = z.infer<typeof operatorOwnerBalancesInputSchema>;

export const operatorOwnerBalancesOutputSchema = z.object({
  ownerType: z.enum(OWNER_TYPES),
  ownerId: z.string(),
  balances: z.array(
    z.object({
      accountId: z.string(),
      assetId: z.string(),
      kind: z.string(),
      purpose: z.string().nullable(),
      amount: z.string().regex(/^-?\d+(\.\d{1,18})?$/),
    }),
  ),
});
export type OperatorOwnerBalancesOutput = z.infer<typeof operatorOwnerBalancesOutputSchema>;

export const OWNER_BALANCES_READ_ACTION = 'owner_balances.read' as const;

/**
 * What an access row records: an owner's balances (0024), one transaction looked up by id or business key (0026), or
 * a page of the ledger desk's transaction list or account address search (0028).
 */
export type OperatorAccessAction =
  typeof OWNER_BALANCES_READ_ACTION | 'transaction.read' | 'trace.read' | 'transactions.list' | 'accounts.search';

export interface OperatorAccessEntry {
  readonly actorId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly requestId: string | null;
  /** Defaults to an owner-balances read. */
  readonly action?: OperatorAccessAction;
}

/** Writes one access row. Throws if it cannot, which refuses the read. */
export async function recordOperatorAccess(sql: Sql, entry: OperatorAccessEntry): Promise<void> {
  await sql`
    INSERT INTO operator_access_log (actor_id, action, target_owner_type, target_owner_id, request_id)
    VALUES (${entry.actorId}, ${entry.action ?? OWNER_BALANCES_READ_ACTION}, ${entry.ownerType}, ${entry.ownerId}, ${entry.requestId})
  `;
}

export interface OwnerBalancesReader {
  recordOperatorAccess(entry: OperatorAccessEntry): Promise<void>;
  balances(ownerType: OperatorOwnerBalancesInput['ownerType'], ownerId: string): Promise<Balance[]>;
}

export async function operatorOwnerBalances(
  reader: OwnerBalancesReader,
  actor: { actorId: string; requestId: string | null },
  input: OperatorOwnerBalancesInput,
): Promise<OperatorOwnerBalancesOutput> {
  const { ownerType, ownerId } = operatorOwnerBalancesInputSchema.parse(input);
  await reader.recordOperatorAccess({ actorId: actor.actorId, ownerType, ownerId, requestId: actor.requestId });
  const balances = await reader.balances(ownerType, ownerId);
  return {
    ownerType,
    ownerId,
    balances: balances.map((b) => ({
      accountId: b.accountId,
      assetId: b.account.assetId,
      kind: b.account.kind,
      purpose: (b.account as { purpose?: string | null }).purpose ?? null,
      amount: formatAmount(b.amount),
    })),
  };
}
