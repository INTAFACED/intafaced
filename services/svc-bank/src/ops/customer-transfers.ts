/**
 * One customer's payments to and from other people, for the console's customer record (OPS-founder-01, J-ops-console-02 #3:
 * the pay tab).
 *
 * Read only: the one-off person-to-person sends (`bank.personal_transfers`, written by `transfers.toUser`) where the customer
 * is the sender or the receiver, newest first, each with its direction from the customer's side, the other person's account
 * id, the amount and coin, whether it posted, and its ledger transaction. No note, reference or handle is read. The operator
 * needs `admin:read`, the operator read scope the console's cards and balances reads use; a customer's own session never
 * reaches it. No audit table is merged for operator reads, so every read writes one structured log line with the operator
 * and the customer BEFORE anything is read; if that line cannot be written the read refuses and reads nothing.
 *
 * The page size is the caller's, 1 to 200, never defaulted. `truncated` says an older payment exists beyond the page.
 */
import { scopedProcedure } from '@intafaced/contracts/trpc';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { writeCustomerReadAudit } from './customer-cards.js';
import { money, type TransferOps } from './transfer-source.js';

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

export function writeCustomerTransfersAudit(actorUserId: string, ownerUserId: string): void {
  writeCustomerReadAudit('bank.ops.customer_transfers_read', actorUserId, ownerUserId);
}

export interface CustomerTransfer {
  id: string;
  direction: 'sent' | 'received';
  counterpartyUserId: string;
  amount: string;
  assetId: string;
  status: string;
  ledgerTxId: string | null;
  createdAt: string;
}

/** One `bank.personal_transfers` row as this read selects it, parsed where it is read. */
const TransferRow = z.object({
  transfer_id: z.string(),
  from_user_id: z.string(),
  to_user_id: z.string(),
  asset_id: z.string(),
  amount: z.string(),
  status: z.string(),
  ledger_tx_id: z.string().nullable(),
  created_at: z.date(),
});

export async function readCustomerTransfers(
  ops: TransferOps,
  userId: string,
  limit: number,
): Promise<{ transfers: CustomerTransfer[]; truncated: boolean }> {
  const rows = TransferRow.array().parse(
    await ops.sql`
      SELECT transfer_id, from_user_id, to_user_id, asset_id, amount::text AS amount, status, ledger_tx_id, created_at
        FROM bank.personal_transfers
       WHERE from_user_id = ${userId} OR to_user_id = ${userId}
       ORDER BY created_at DESC, transfer_id DESC
       LIMIT ${limit + 1}
    `,
  );
  return {
    transfers: rows.slice(0, limit).map((row) => {
      const sent = row.from_user_id === userId;
      return {
        id: row.transfer_id,
        direction: sent ? 'sent' : 'received',
        counterpartyUserId: sent ? row.to_user_id : row.from_user_id,
        amount: money(row.amount),
        assetId: row.asset_id,
        status: row.status,
        ledgerTxId: row.ledger_tx_id,
        createdAt: row.created_at.toISOString(),
      };
    }),
    truncated: rows.length > limit,
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function customerTransfersProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(z.object({ userId: z.string().guid(), limit: z.number().int().min(1).max(200) }).strict())
    .output(
      z.object({
        userId: z.string(),
        transfers: z.array(
          z.object({
            id: z.string(),
            direction: z.enum(['sent', 'received']),
            counterpartyUserId: z.string(),
            amount: amountString,
            assetId: z.string(),
            status: z.string(),
            ledgerTxId: z.string().nullable(),
            createdAt: z.string(),
          }),
        ),
        truncated: z.boolean(),
      }),
    )
    .query(({ ctx, input }) =>
      guard(async () => {
        writeCustomerTransfersAudit(ctx.principal.userId, input.userId);
        const page = await readCustomerTransfers(bank.transferOps, input.userId, input.limit);
        return { userId: input.userId, ...page };
      }),
    );
}
