import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { roleHasPermission, type MerchantCaller } from '../merchant-ops/roles.js';

/**
 * Customer receipts (M-plat-org-10).
 *
 * Email delivery is not connected. A send that would otherwise be allowed
 * refuses `vendor.email` and writes nothing: no queue row, no address.
 * Amounts come from the payment row and the capture/refund event log.
 */

export const RECEIPT_KINDS = ['payment', 'refund'] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

const PAID_STATUSES = new Set(['captured', 'settled', 'refunded', 'disputed']);

export class ReceiptNotConnected extends Error {
  readonly code = 'vendor.email' as const;
  readonly blockers = [{ code: 'vendor.email' }] as const;
  constructor() {
    super('vendor.email');
    this.name = 'ReceiptNotConnected';
  }
}

export interface ReceiptFacts {
  readonly status: string;
  readonly captured: bigint;
  readonly refunded: bigint;
}

export type ReceiptGate =
  | { readonly ok: true; readonly hasCapture: boolean }
  | {
      readonly ok: false;
      readonly hasCapture: boolean;
      readonly code: 'pay.receipt_not_offered' | 'pay.receipt_not_paid' | 'pay.receipt_refund_absent';
    };

/** Whether a receipt of this kind may be sent. A pending payment is never treated as paid. */
export function gateReceipt(kind: ReceiptKind, facts: ReceiptFacts): ReceiptGate {
  const hasCapture = facts.captured > 0n && PAID_STATUSES.has(facts.status);
  if (kind === 'refund') {
    if (facts.refunded > 0n) return { ok: true, hasCapture };
    return { ok: false, hasCapture, code: 'pay.receipt_refund_absent' };
  }
  if (facts.status === 'failed') return { ok: false, hasCapture: false, code: 'pay.receipt_not_offered' };
  if (!hasCapture) return { ok: false, hasCapture: false, code: 'pay.receipt_not_paid' };
  return { ok: true, hasCapture: true };
}

/**
 * Automatic payment receipts. Unset or off stops them. On does not queue:
 * there is no email provider, so the answer is not connected.
 */
export function automaticReceipts(receipts: boolean | null): 'stopped' | 'not_connected' {
  return receipts === true ? 'not_connected' : 'stopped';
}

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Refuse a blank or unusable address. The address is not returned and not stored. */
export function assertReceiptAddress(raw: string): void {
  const address = raw.trim().toLowerCase();
  if (address.length < 3 || address.length > 320 || address.includes(' ') || !ADDRESS.test(address)) {
    throw new MerchantOpsError('pay.receipt_address_invalid', 'bad_request');
  }
}

function decimal(value: string | null | undefined): string {
  if (value == null || value.trim() === '') throw new MerchantOpsError('pay.receipt_amount_unreadable', 'unavailable');
  try {
    return formatAmount(parseAmount(value));
  } catch {
    throw new MerchantOpsError('pay.receipt_amount_unreadable', 'unavailable');
  }
}

function scaled(value: string): bigint {
  try {
    return parseAmount(value);
  } catch {
    throw new MerchantOpsError('pay.receipt_amount_unreadable', 'unavailable');
  }
}

export interface ReceiptPreview {
  readonly paymentId: string;
  readonly status: string;
  readonly currency: string;
  readonly authorizedAmount: string;
  readonly capturedAmount: string;
  readonly refundedAmount: string;
  readonly hasCapture: boolean;
  readonly paymentReceipt: 'offered' | 'not_offered' | 'not_paid';
  readonly refundReceipt: 'offered' | 'not_refunded';
  readonly delivery: { readonly status: 'not_connected'; readonly notConnected: 'vendor.email' };
}

const DELIVERY = { status: 'not_connected', notConnected: 'vendor.email' } as const;

export class ReceiptService {
  constructor(private readonly sql: Sql) {}

  async preview(caller: MerchantCaller, paymentId: string): Promise<ReceiptPreview> {
    this.assertCanRead(caller);
    const loaded = await this.load(caller, paymentId);
    const payment = gateReceipt('payment', loaded);
    const refund = gateReceipt('refund', loaded);
    return {
      paymentId,
      status: loaded.status,
      currency: loaded.currency,
      authorizedAmount: loaded.authorizedAmount,
      capturedAmount: loaded.capturedAmount,
      refundedAmount: loaded.refundedAmount,
      hasCapture: payment.hasCapture,
      paymentReceipt: payment.ok ? 'offered' : payment.code === 'pay.receipt_not_offered' ? 'not_offered' : 'not_paid',
      refundReceipt: refund.ok ? 'offered' : 'not_refunded',
      delivery: DELIVERY,
    };
  }

  /**
   * Manual send. The receipts switch does not block it. Nothing is written:
   * delivery is not connected, so there is no queued receipt.
   */
  async send(caller: MerchantCaller, input: { paymentId: string; kind: ReceiptKind; address: string }): Promise<never> {
    if (caller.role === 'viewer' || !roleHasPermission(caller.role, 'payments.read')) {
      throw new MerchantOpsError('pay.team_role_forbidden', 'forbidden');
    }
    const loaded = await this.load(caller, input.paymentId);
    const gate = gateReceipt(input.kind, loaded);
    if (!gate.ok) throw new MerchantOpsError(gate.code, 'precondition');
    assertReceiptAddress(input.address);
    throw new ReceiptNotConnected();
  }

  private assertCanRead(caller: MerchantCaller): void {
    if (!roleHasPermission(caller.role, 'payments.read')) throw new MerchantOpsError('pay.team_role_forbidden', 'forbidden');
  }

  private async load(caller: MerchantCaller, paymentId: string) {
    const rows = await this.sql<Array<{ amount: string; currency: string; status: string }>>`
      SELECT amount::text AS amount, currency, status::text AS status
        FROM pay.payments
       WHERE id = ${paymentId} AND merchant_id = ${caller.merchantId}`;
    const row = rows[0];
    if (!row || row.currency.trim() === '') throw new MerchantOpsError('pay.receipt_not_found', 'not_found');
    let totals: Array<{ captured: string; refunded: string }>;
    try {
      totals = await this.sql<Array<{ captured: string; refunded: string }>>`
        SELECT
          COALESCE(SUM(CASE WHEN event = 'captured' THEN (payload->>'amount')::numeric END), 0)::text AS captured,
          COALESCE(SUM(CASE WHEN event = 'refunded' THEN (payload->>'amount')::numeric END), 0)::text AS refunded
          FROM pay.payment_events
         WHERE payment_id = ${paymentId}`;
    } catch {
      throw new MerchantOpsError('pay.receipt_amount_unreadable', 'unavailable');
    }
    const total = totals[0];
    if (!total) throw new MerchantOpsError('pay.receipt_amount_unreadable', 'unavailable');
    const capturedAmount = decimal(total.captured);
    const refundedAmount = decimal(total.refunded);
    return {
      status: row.status,
      currency: row.currency,
      authorizedAmount: decimal(row.amount),
      capturedAmount,
      refundedAmount,
      captured: scaled(capturedAmount),
      refunded: scaled(refundedAmount),
    };
  }
}
