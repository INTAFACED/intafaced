/**
 * One transfer row for an operator.
 *
 * Standing-order executions and PAYSEND one-off rows. Unknown and malformed
 * ids are the same not-found. No audit table is merged for operator reads
 * (ADMINOPS is the support desk; BANKOPS did not add one), so each read writes
 * one structured log line: actor and id. Nothing is inserted.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import { EXECUTION_ID, money, rejectionReason, type TransferOps } from './transfer-source.js';

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);
const NOT_FOUND = 'No such transfer (bank.ops_transfer_not_found)';

export interface TransferDetail {
  id: string;
  kind: 'standing_order' | 'one_off';
  senderUserId: string;
  receiverUserId: string;
  amount: string;
  assetId: string;
  status: string;
  rejectionCode: string | null;
  reason: string | null;
  ledgerTxId: string | null;
  scheduleId: string | null;
  occurrence: number | null;
  attemptedAt: string;
  settledAt: string | null;
}

interface ExecutionRow {
  id: string;
  schedule_id: string;
  occurrence: number;
  amount: string;
  asset_id: string;
  status: string;
  rejection_code: string | null;
  ledger_tx_id: string | null;
  attempted_at: Date;
  settled_at: Date | null;
  sender_user_id: string;
  receiver_user_id: string;
}

interface OneOffRow {
  transfer_id: string;
  from_user_id: string;
  to_user_id: string;
  asset_id: string;
  amount: string;
  status: string;
  ledger_tx_id: string | null;
  created_at: Date;
}

export function writeTransferDetailAudit(actorUserId: string, id: string): void {
  console.info(
    JSON.stringify({
      level: 'info',
      service: 'svc-bank',
      event: 'bank.ops.transfer_detail_read',
      actorUserId,
      id,
    }),
  );
}

export async function readTransferDetail(ops: TransferOps, id: string): Promise<TransferDetail> {
  const execution = EXECUTION_ID.test(id) ? await executionById(ops, id) : null;
  if (execution) return execution;
  const oneOff = await oneOffById(ops, id);
  if (oneOff) return oneOff;
  throw new BankError(NOT_FOUND, 'bank.ops_transfer_not_found');
}

async function executionById(ops: TransferOps, id: string): Promise<TransferDetail | null> {
  const rows = await ops.sql<ExecutionRow[]>`
    SELECT e.id, e.schedule_id, e.occurrence, e.amount::text AS amount, s.asset_id, e.status,
           e.rejection_code, e.ledger_tx_id, e.attempted_at, e.settled_at,
           s.user_id AS sender_user_id, dest.user_id AS receiver_user_id
      FROM bank.transfer_executions e
      JOIN bank.scheduled_transfers s ON s.id = e.schedule_id
      JOIN bank.spaces dest ON dest.id = s.to_space_id
     WHERE e.id = ${id}::uuid
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    kind: 'standing_order',
    senderUserId: row.sender_user_id,
    receiverUserId: row.receiver_user_id,
    amount: money(row.amount),
    assetId: row.asset_id,
    status: row.status,
    rejectionCode: row.rejection_code,
    reason: rejectionReason(row.rejection_code),
    ledgerTxId: row.ledger_tx_id,
    scheduleId: row.schedule_id,
    occurrence: row.occurrence,
    attemptedAt: row.attempted_at.toISOString(),
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
  };
}

async function oneOffById(ops: TransferOps, id: string): Promise<TransferDetail | null> {
  const rows = await ops.sql<OneOffRow[]>`
    SELECT transfer_id, from_user_id, to_user_id, asset_id, amount::text AS amount,
           status, ledger_tx_id, created_at
      FROM bank.personal_transfers
     WHERE transfer_id = ${id}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.transfer_id,
    kind: 'one_off',
    senderUserId: row.from_user_id,
    receiverUserId: row.to_user_id,
    amount: money(row.amount),
    assetId: row.asset_id,
    status: row.status,
    rejectionCode: null,
    reason: null,
    ledgerTxId: row.ledger_tx_id,
    scheduleId: null,
    occurrence: null,
    attemptedAt: row.created_at.toISOString(),
    settledAt: null,
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function transferDetailProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:compliance')
    .input(z.object({ id: z.string() }))
    .output(
      z.object({
        id: z.string(),
        kind: z.enum(['standing_order', 'one_off']),
        senderUserId: z.string(),
        receiverUserId: z.string(),
        amount: amountString,
        assetId: z.string(),
        status: z.string(),
        rejectionCode: z.string().nullable(),
        reason: z.string().nullable(),
        ledgerTxId: z.string().nullable(),
        scheduleId: z.string().nullable(),
        occurrence: z.number().int().nullable(),
        attemptedAt: z.string(),
        settledAt: z.string().nullable(),
      }),
    )
    .query(({ ctx, input }) =>
      guard(async () => {
        writeTransferDetailAudit(ctx.principal.userId, input.id);
        return readTransferDetail(bank.transferOps, input.id);
      }),
    );
}
