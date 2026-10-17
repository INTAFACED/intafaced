/**
 * Rejected standing-order executions, newest first.
 *
 * PAYSEND's `personal_transfers` has no failed status (`reserved` or `posted`
 * only), so this list does not invent one-off failures. Handles come from the
 * identity lookup the send path uses. An unknown account is null with
 * `handle_unresolved`. A missing IDENTITY_URL refuses; it is not "no handle".
 * The page carries no user id.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import { PartyHandleUnavailableError } from '../transfers/party-handles.js';
import { assertWindowHours, EXECUTION_ID, money, rejectionReason, windowStart, type TransferOps } from './transfer-source.js';

const LIST_CAP = 200;
const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

export interface FailedTransferParty {
  handle: string | null;
  reason: 'handle_unresolved' | null;
}

export interface FailedTransfer {
  id: string;
  kind: 'standing_order';
  amount: string;
  assetId: string;
  status: 'rejected';
  rejectionCode: string;
  reason: string;
  attemptedAt: string;
  sender: FailedTransferParty;
  receiver: FailedTransferParty;
}

interface FailedRow {
  id: string;
  amount: string;
  asset_id: string;
  status: string;
  rejection_code: string;
  attempted_us: string;
  attempted_at: Date;
  sender_user_id: string;
  receiver_user_id: string;
}

export function assertFailedTransfersLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new BankError(
      'failedTransfers page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit) (bank.failed_transfers_limit_unset)',
      'bank.failed_transfers_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new BankError(
      'failedTransfers page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit) (bank.failed_transfers_limit_unset)',
      'bank.failed_transfers_limit_unset',
    );
  }
  return Math.min(LIST_CAP, n);
}

function decodeCursor(cursor: string): { us: string; id: string } {
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new BankError(
      'Failed-transfer cursor is not a page this service issued (bank.failed_transfers_cursor_invalid)',
      'bank.failed_transfers_cursor_invalid',
    );
  }
  const nl = text.indexOf('\n');
  const us = nl > 0 ? text.slice(0, nl) : '';
  const id = nl > 0 ? text.slice(nl + 1) : '';
  if (!/^[0-9]{1,20}$/.test(us) || !EXECUTION_ID.test(id)) {
    throw new BankError(
      'Failed-transfer cursor is not a page this service issued (bank.failed_transfers_cursor_invalid)',
      'bank.failed_transfers_cursor_invalid',
    );
  }
  return { us, id };
}

function encodeCursor(us: string, id: string): string {
  return Buffer.from(`${us}\n${id}`, 'utf8').toString('base64url');
}

async function party(ops: TransferOps, userId: string): Promise<FailedTransferParty> {
  const port = ops.handles;
  if (!port) {
    throw new BankError(
      'IDENTITY_URL is unset, so a failed transfer cannot name either person (bank.party_handles_unset)',
      'bank.party_handles_unset',
    );
  }
  let handle: string | null;
  try {
    handle = await port.handleOf(userId);
  } catch (err) {
    if (err instanceof PartyHandleUnavailableError) {
      throw new BankError('Identity did not answer a handle lookup (bank.party_handles_unavailable)', 'bank.party_handles_unavailable');
    }
    throw err;
  }
  if (handle === null || handle.trim() === '') return { handle: null, reason: 'handle_unresolved' };
  return { handle, reason: null };
}

export async function readFailedTransfers(
  ops: TransferOps,
  windowHours: number,
  limit: number,
  cursor: string | undefined,
  now = new Date(),
): Promise<{ items: FailedTransfer[]; nextCursor: string | null }> {
  const since = windowStart(now, windowHours);
  const page = assertFailedTransfersLimit(limit);
  const mark = cursor === undefined ? null : decodeCursor(cursor);
  const rows = mark
    ? await ops.sql<FailedRow[]>`
        SELECT e.id, e.amount::text AS amount, s.asset_id, e.status, e.rejection_code,
               (extract(epoch FROM e.attempted_at) * 1000000)::bigint::text AS attempted_us,
               e.attempted_at, s.user_id AS sender_user_id, dest.user_id AS receiver_user_id
          FROM bank.transfer_executions e
          JOIN bank.scheduled_transfers s ON s.id = e.schedule_id
          JOIN bank.spaces dest ON dest.id = s.to_space_id
         WHERE e.status = 'rejected'
           AND e.attempted_at >= ${since}
           AND e.attempted_at <= ${now}
           AND (e.attempted_at, e.id) < (
             timestamptz 'epoch' + ${mark.us}::bigint * interval '1 microsecond',
             ${mark.id}::uuid
           )
         ORDER BY e.attempted_at DESC, e.id DESC
         LIMIT ${page + 1}
      `
    : await ops.sql<FailedRow[]>`
        SELECT e.id, e.amount::text AS amount, s.asset_id, e.status, e.rejection_code,
               (extract(epoch FROM e.attempted_at) * 1000000)::bigint::text AS attempted_us,
               e.attempted_at, s.user_id AS sender_user_id, dest.user_id AS receiver_user_id
          FROM bank.transfer_executions e
          JOIN bank.scheduled_transfers s ON s.id = e.schedule_id
          JOIN bank.spaces dest ON dest.id = s.to_space_id
         WHERE e.status = 'rejected'
           AND e.attempted_at >= ${since}
           AND e.attempted_at <= ${now}
         ORDER BY e.attempted_at DESC, e.id DESC
         LIMIT ${page + 1}
      `;
  const pageRows = rows.slice(0, page);
  const items: FailedTransfer[] = [];
  for (const row of pageRows) {
    const reason = rejectionReason(row.rejection_code);
    if (reason === null) throw new Error('a rejected execution has no rejection code');
    items.push({
      id: row.id,
      kind: 'standing_order',
      amount: money(row.amount),
      assetId: row.asset_id,
      status: 'rejected',
      rejectionCode: row.rejection_code,
      reason,
      attemptedAt: row.attempted_at.toISOString(),
      sender: await party(ops, row.sender_user_id),
      receiver: await party(ops, row.receiver_user_id),
    });
  }
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor: rows.length > page && last ? encodeCursor(last.attempted_us, last.id) : null,
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const partyOutput = z.object({
  handle: z.string().nullable(),
  reason: z.literal('handle_unresolved').nullable(),
});

export function failedTransfersProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:compliance')
    .input(
      z.object({
        windowHours: z.number().int().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      }),
    )
    .output(
      z.object({
        items: z.array(
          z.object({
            id: z.string(),
            kind: z.literal('standing_order'),
            amount: amountString,
            assetId: z.string(),
            status: z.literal('rejected'),
            rejectionCode: z.string(),
            reason: z.string(),
            attemptedAt: z.string(),
            sender: partyOutput,
            receiver: partyOutput,
          }),
        ),
        nextCursor: z.string().nullable(),
      }),
    )
    .query(({ input }) =>
      guard(async () => {
        const windowHours = assertWindowHours(input.windowHours, 'bank.failed_transfers_window_unset', 'Failed transfers');
        const limit = assertFailedTransfersLimit(input.limit);
        return readFailedTransfers(bank.transferOps, windowHours, limit, input.cursor);
      }),
    );
}
