import type { Sql } from 'postgres';
import {
  formatAmount,
  merchantClearing,
  merchantProceeds,
  parseAmount,
  userAvailable,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';
import type { PayFail } from './common.js';
import { asUuid, assertPortalPageLimit, pageCursor, portalFilters } from './common.js';

type Reader = Pick<LedgerClient, 'getTx' | 'getTxByKey' | 'balance'>;

const PAYMENT_STATUSES = new Set(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']);

export interface RefundLedgerEffect {
  recorded: boolean;
  pot: 'clearing' | 'merchantProceeds' | 'userAvailable' | null;
  ledgerTxId: string | null;
  direction: 'debit' | 'credit' | null;
}

export interface RefundItem {
  id: string;
  refundId: string;
  paymentId: string;
  merchantId: string;
  amount: string;
  assetId: string;
  reason: string | null;
  actor: string | null;
  status: 'posted' | 'settled' | 'reversed';
  createdAt: string;
  settledAt: string | null;
  source: 'clearing' | 'settled' | null;
  ledgerEffect: RefundLedgerEffect;
  payment: { paymentId: string; status: 'created' | 'authorized' | 'captured' | 'settled' | 'refunded' | 'disputed' | 'failed' };
}

interface RefundRow {
  id: string;
  payment_id: string;
  merchant_id: string;
  user_id: string;
  currency: string;
  payment_status: string;
  payload: Record<string, unknown>;
  ts: Date;
  created_at_cursor: string;
  settled_at: Date | null;
  reversed_at: Date | null;
}

async function refundRows(
  sql: Sql,
  where: {
    merchantId?: string;
    refundEventId?: string;
    filters?: ReturnType<typeof portalFilters>;
    status?: string;
    paymentId?: string;
    limit?: number;
  },
): Promise<RefundRow[]> {
  const filters = where.filters;
  const cursorAt = filters?.cursor?.createdAtCursor ?? null;
  const cursorId = filters?.cursor?.id ?? null;
  const search = filters?.search ?? null;
  const assetId = filters?.assetId ?? null;
  const from = filters?.from ?? null;
  const to = filters?.to ?? null;
  const status = where.status ?? null;
  const paymentId = where.paymentId ?? null;
  const merchantId = where.merchantId ?? null;
  const refundEventId = where.refundEventId ?? null;
  const limit = where.limit === undefined ? 2 : where.limit + 1;
  return sql<RefundRow[]>`
    SELECT e.id, e.payment_id, p.merchant_id, m.user_id, p.currency, p.status::text AS payment_status,
           e.payload, e.ts,
           to_char(e.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
           done.ts AS settled_at,
           rev.ts AS reversed_at
      FROM pay.payment_events e
      JOIN pay.payments p ON p.id = e.payment_id
      JOIN pay.merchants m ON m.id = p.merchant_id
      LEFT JOIN LATERAL (
        SELECT ts FROM pay.payment_events d
         WHERE d.payment_id = e.payment_id AND d.event = 'refunded'
           AND d.payload->>'refundId' = e.payload->>'refundId'
         ORDER BY d.seq DESC LIMIT 1
      ) done ON true
      LEFT JOIN LATERAL (
        SELECT ts FROM pay.payment_events r
         WHERE r.payment_id = e.payment_id AND r.event = 'refund.reversed'
           AND r.payload->>'refundId' = e.payload->>'refundId'
         ORDER BY r.seq DESC LIMIT 1
      ) rev ON true
     WHERE e.event = 'refund.posted'
       AND (${merchantId}::uuid IS NULL OR p.merchant_id = ${merchantId})
       AND (${refundEventId}::uuid IS NULL OR e.id = ${refundEventId})
       AND (${paymentId}::uuid IS NULL OR e.payment_id = ${paymentId})
       AND (${assetId}::text IS NULL OR p.currency = ${assetId})
       AND (${from}::timestamptz IS NULL OR e.ts >= ${from})
       AND (${to}::timestamptz IS NULL OR e.ts < ${to})
       AND (
         ${search}::text IS NULL
         OR e.payload->>'refundId' = ${search}
         OR e.payment_id::text = lower(${search})
         OR e.payload->>'amount' = ${search}
       )
       AND (
         ${status}::text IS NULL
         OR (${status} = 'reversed' AND rev.ts IS NOT NULL)
         OR (${status} = 'settled' AND rev.ts IS NULL AND done.ts IS NOT NULL)
         OR (${status} = 'posted' AND rev.ts IS NULL AND done.ts IS NULL)
       )
       AND (
         ${cursorAt}::timestamptz IS NULL
         OR (e.ts, e.id) < (${cursorAt}::timestamptz, ${cursorId}::uuid)
       )
     ORDER BY e.ts DESC, e.id DESC
     LIMIT ${limit}
  `;
}

function optionalReason(payload: Record<string, unknown>): string | null {
  const reason = payload.reason;
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  if (trimmed.length < 1 || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function eventSource(payload: Record<string, unknown>): 'clearing' | 'settled' | null {
  if (payload.source === 'clearing' || payload.source === 'settled') return payload.source;
  return null;
}

async function effectOf(ledger: Reader, row: RefundRow, fail: PayFail): Promise<{ amount: string; ledgerEffect: RefundLedgerEffect }> {
  const raw = row.payload.amount;
  if (typeof raw !== 'string') fail('Refund amount was not stored', 'pay.invalid_amount');
  let amount: string;
  try {
    amount = formatAmount(parseAmount(raw));
  } catch {
    return fail('Refund amount was not stored as a decimal', 'pay.invalid_amount');
  }
  const refundId = typeof row.payload.refundId === 'string' ? row.payload.refundId : '';
  const key = `payment.refund:${row.payment_id}:${refundId}`;
  const hinted = asUuid(row.payload.ledgerTxId);
  const tx = (hinted ? await ledger.getTx(hinted) : null) ?? (await ledger.getTxByKey(key));
  if (!tx || tx.idempotencyKey !== key) {
    return { amount, ledgerEffect: { recorded: false, pot: null, ledgerTxId: null, direction: null } };
  }
  const pot = await potOf(ledger, tx, row);
  const entry = pot === null ? null : tx.entries.find((e) => e.direction === 'credit' && e.assetId === row.currency);
  return {
    amount,
    ledgerEffect: {
      recorded: true,
      pot,
      ledgerTxId: tx.id,
      direction: entry?.direction ?? null,
    },
  };
}

async function potOf(ledger: Reader, tx: LedgerTx, row: RefundRow): Promise<RefundLedgerEffect['pot']> {
  const clearing = (await ledger.balance(merchantClearing(row.merchant_id, row.currency))).accountId;
  const proceeds = (await ledger.balance(merchantProceeds(row.merchant_id, row.currency))).accountId;
  const personal = (await ledger.balance(userAvailable(row.user_id, row.currency))).accountId;
  const credited = tx.entries.filter((e) => e.direction === 'credit');
  if (clearing && credited.some((e) => e.accountId === clearing)) return 'clearing';
  if (proceeds && credited.some((e) => e.accountId === proceeds)) return 'merchantProceeds';
  if (personal && credited.some((e) => e.accountId === personal)) return 'userAvailable';
  return null;
}

function statusOf(row: RefundRow): RefundItem['status'] {
  if (row.reversed_at) return 'reversed';
  if (row.settled_at) return 'settled';
  return 'posted';
}

async function toItem(ledger: Reader, row: RefundRow, fail: PayFail): Promise<RefundItem> {
  const refundId = row.payload.refundId;
  if (typeof refundId !== 'string' || refundId.trim().length < 1) fail('Refund id was not stored', 'pay.invalid_amount');
  if (!PAYMENT_STATUSES.has(row.payment_status)) fail('Payment status on a refund is not a known status', 'pay.invalid_transition');
  const { amount, ledgerEffect } = await effectOf(ledger, row, fail);
  return {
    id: row.id,
    refundId: (refundId as string).trim(),
    paymentId: row.payment_id,
    merchantId: row.merchant_id,
    amount,
    assetId: row.currency,
    reason: optionalReason(row.payload),
    actor: asUuid(row.payload.actor),
    status: statusOf(row),
    createdAt: row.ts.toISOString(),
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
    source: eventSource(row.payload),
    ledgerEffect,
    payment: {
      paymentId: row.payment_id,
      status: row.payment_status as RefundItem['payment']['status'],
    },
  };
}

export async function listMerchantRefunds(
  sql: Sql,
  ledger: Reader,
  input: {
    merchantId: string;
    status?: RefundItem['status'];
    limit?: number;
    cursor?: string;
    search?: string;
    assetId?: string;
    from?: string;
    to?: string;
    paymentId?: string;
  },
  fail: PayFail,
): Promise<{ items: RefundItem[]; nextCursor: string | null }> {
  const limit = assertPortalPageLimit(input.limit, 'pay.refund_list_limit_unset', 'payment.refunds.list', fail);
  const filters = portalFilters(input, fail);
  const rows = await refundRows(sql, {
    merchantId: input.merchantId,
    filters,
    status: input.status,
    paymentId: input.paymentId,
    limit,
  });
  const page = rows.slice(0, limit);
  const items: RefundItem[] = [];
  for (const row of page) items.push(await toItem(ledger, row, fail));
  return { items, nextCursor: pageCursor(rows, limit) };
}

export async function readMerchantRefund(sql: Sql, ledger: Reader, refundEventId: string, fail: PayFail): Promise<RefundItem> {
  const rows = await refundRows(sql, { refundEventId });
  const row = rows[0];
  if (!row) return fail(`Refund ${refundEventId} not found`, 'pay.refund_not_found');
  return toItem(ledger, row, fail);
}
