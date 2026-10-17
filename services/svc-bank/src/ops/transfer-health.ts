/**
 * Operator health for personal transfers.
 *
 * Standing orders are counted from `transfer_executions` attempted in the
 * window. One-off sends are counted from PAYSEND's `personal_transfers`
 * (`reserved` and `posted` only). That table has no failed status: a refusal
 * deletes the reservation, so the failure rate is null with
 * `failures_not_recorded` rather than a zero. P2P is `ops.counts` /
 * `ops.disputeRate24h` on svc-p2p. Bills use PAYBILLS' status words.
 * No per-user row and no id.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { ageSeconds, assertWindowHours, countOf, exactRatio, windowStart, type TransferOps } from './transfer-source.js';

const ratioString = z.string().regex(/^(?:\d+(?:\.\d+)?|\d+\/\d+)$/);

export interface StandingOrderHealth {
  pending: number;
  settled: number;
  rejected: number;
  skipped: number;
  total: number;
  failureRate: string | null;
  oldestPendingAgeSeconds: number | null;
}

export interface OneOffHealth {
  available: true;
  reserved: number;
  posted: number;
  total: number;
  failureRate: null;
  failureRateReason: 'failures_not_recorded';
  oldestPendingAgeSeconds: number | null;
}

export interface BillHealth {
  available: true;
  submitted: number;
  accepted: number;
  paid: number;
  failed: number;
  returned: number;
  total: number;
  failureRate: string | null;
  oldestPendingAgeSeconds: number | null;
}

export interface TransferHealth {
  asOf: string;
  standingOrders: StandingOrderHealth;
  oneOff: OneOffHealth;
  p2p: { available: false; reason: 'served_by_p2p_ops' };
  bills: BillHealth;
}

interface StandingRow {
  pending: number;
  settled: number;
  rejected: number;
  skipped: number;
  total: number;
  oldest: string | null;
}

interface OneOffRow {
  reserved: number;
  posted: number;
  total: number;
  oldest: string | null;
}

interface BillRow {
  submitted: number;
  accepted: number;
  paid: number;
  failed: number;
  returned: number;
  total: number;
  oldest: string | null;
}

export async function readTransferHealth(ops: TransferOps, windowHours: number, now = new Date()): Promise<TransferHealth> {
  const since = windowStart(now, windowHours);
  const [standing, oneOff, bills] = await Promise.all([
    standingOrders(ops, since, now),
    oneOffTransfers(ops, since, now),
    billPayments(ops, since, now),
  ]);
  return {
    asOf: now.toISOString(),
    standingOrders: standing,
    oneOff,
    p2p: { available: false, reason: 'served_by_p2p_ops' },
    bills,
  };
}

async function standingOrders(ops: TransferOps, since: Date, now: Date): Promise<StandingOrderHealth> {
  const rows = await ops.sql<StandingRow[]>`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'settled')::int AS settled,
      count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
      count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
      count(*)::int AS total,
      (
        SELECT floor(extract(epoch FROM (${now}::timestamptz - attempted_at)))::text
          FROM bank.transfer_executions
         WHERE status = 'pending'
           AND attempted_at >= ${since}
           AND attempted_at <= ${now}
         ORDER BY attempted_at ASC, id ASC
         LIMIT 1
      ) AS oldest
    FROM bank.transfer_executions
    WHERE attempted_at >= ${since} AND attempted_at <= ${now}
  `;
  const row = rows[0];
  if (!row) throw new Error('transfer health returned no standing-order aggregate');
  const rejected = countOf(row.rejected);
  const total = countOf(row.total);
  return {
    pending: countOf(row.pending),
    settled: countOf(row.settled),
    rejected,
    skipped: countOf(row.skipped),
    total,
    failureRate: exactRatio(rejected, total),
    oldestPendingAgeSeconds: ageSeconds(row.oldest),
  };
}

async function oneOffTransfers(ops: TransferOps, since: Date, now: Date): Promise<OneOffHealth> {
  const rows = await ops.sql<OneOffRow[]>`
    SELECT
      count(*) FILTER (WHERE status = 'reserved')::int AS reserved,
      count(*) FILTER (WHERE status = 'posted')::int AS posted,
      count(*)::int AS total,
      (
        SELECT floor(extract(epoch FROM (${now}::timestamptz - created_at)))::text
          FROM bank.personal_transfers
         WHERE status = 'reserved'
           AND created_at >= ${since}
           AND created_at <= ${now}
         ORDER BY created_at ASC, transfer_id ASC
         LIMIT 1
      ) AS oldest
    FROM bank.personal_transfers
    WHERE created_at >= ${since} AND created_at <= ${now}
  `;
  const row = rows[0];
  if (!row) throw new Error('transfer health returned no one-off aggregate');
  return {
    available: true,
    reserved: countOf(row.reserved),
    posted: countOf(row.posted),
    total: countOf(row.total),
    failureRate: null,
    failureRateReason: 'failures_not_recorded',
    oldestPendingAgeSeconds: ageSeconds(row.oldest),
  };
}

async function billPayments(ops: TransferOps, since: Date, now: Date): Promise<BillHealth> {
  const rows = await ops.sql<BillRow[]>`
    SELECT
      count(*) FILTER (WHERE status = 'submitted')::int AS submitted,
      count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
      count(*) FILTER (WHERE status = 'paid')::int AS paid,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status = 'returned')::int AS returned,
      count(*)::int AS total,
      (
        SELECT floor(extract(epoch FROM (${now}::timestamptz - created_at)))::text
          FROM bank.bill_payments
         WHERE status = 'submitted'
           AND created_at >= ${since}
           AND created_at <= ${now}
         ORDER BY created_at ASC, id ASC
         LIMIT 1
      ) AS oldest
    FROM bank.bill_payments
    WHERE created_at >= ${since} AND created_at <= ${now}
  `;
  const row = rows[0];
  if (!row) throw new Error('transfer health returned no bill aggregate');
  const failed = countOf(row.failed);
  const total = countOf(row.total);
  return {
    available: true,
    submitted: countOf(row.submitted),
    accepted: countOf(row.accepted),
    paid: countOf(row.paid),
    failed,
    returned: countOf(row.returned),
    total,
    failureRate: exactRatio(failed, total),
    oldestPendingAgeSeconds: ageSeconds(row.oldest),
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const standingOutput = z.object({
  pending: z.number().int().nonnegative(),
  settled: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  failureRate: ratioString.nullable(),
  oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
});

export function transferHealthProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(z.object({ windowHours: z.number().int().optional() }))
    .output(
      z.object({
        asOf: z.string(),
        standingOrders: standingOutput,
        oneOff: z.object({
          available: z.literal(true),
          reserved: z.number().int().nonnegative(),
          posted: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
          failureRate: z.null(),
          failureRateReason: z.literal('failures_not_recorded'),
          oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
        }),
        p2p: z
          .object({
            available: z.literal(false),
            reason: z.literal('served_by_p2p_ops'),
          })
          .strict(),
        bills: z.object({
          available: z.literal(true),
          submitted: z.number().int().nonnegative(),
          accepted: z.number().int().nonnegative(),
          paid: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          returned: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
          failureRate: ratioString.nullable(),
          oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
        }),
      }),
    )
    .query(({ input }) =>
      guard(async () => {
        const windowHours = assertWindowHours(input.windowHours, 'bank.transfer_health_window_unset', 'Transfer health');
        return readTransferHealth(bank.transferOps, windowHours);
      }),
    );
}
