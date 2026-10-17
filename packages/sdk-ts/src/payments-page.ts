/**
 * GET /payments page.
 *
 * The wire body is `{ items, nextCursor }`. `nextCursor` is null on the last
 * page. Amounts stay decimal strings. A missing pricing snapshot stays null:
 * the client does not invent a fee.
 */
import type { PayResponse } from './client.js';

const AMOUNT = /^\d+(\.\d{1,18})?$/;
const STATUSES = ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed'] as const;

export type PayPaymentStatus = (typeof STATUSES)[number];

export interface PayFailure {
  readonly code: string;
  readonly message: string;
}

export interface PayPayment {
  readonly id: string;
  readonly merchantId: string;
  readonly profileId: string | null;
  readonly amount: string;
  readonly assetId: string;
  readonly method: string | null;
  readonly railAdapter: string | null;
  readonly railRef: string | null;
  readonly status: PayPaymentStatus;
  readonly mode: 'live' | 'sandbox';
  readonly capturedAmount: string;
  readonly refundedAmount: string;
  readonly createdAt: string;
  /** Stored fee row, a narrow `{ fee }` read, or null when no fee was stored. */
  readonly pricingSnapshot: Readonly<Record<string, unknown>> | null;
  readonly failure: PayFailure | null;
}

export interface PayPaymentPage {
  readonly items: readonly PayPayment[];
  readonly nextCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !AMOUNT.test(value)) {
    throw new Error(`${label} must be a decimal string`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} is not a string`);
  return value;
}

/** Money on the snapshot. Basis points stay integers and are not amounts. */
const SNAPSHOT_MONEY = ['flatFee', 'bookedFee', 'reserveAmount'] as const;

function pricingSnapshot(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error('payments pricing snapshot is not an object');
  decimal(value.fee, 'payments pricing snapshot fee');
  for (const key of SNAPSHOT_MONEY) {
    if (!Object.hasOwn(value, key) || value[key] === null) continue;
    decimal(value[key], `payments pricing snapshot ${key}`);
  }
  return { ...value };
}

function failure(value: unknown): PayFailure | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error('payments failure is not an object');
  const code = requiredString(value.code, 'payments failure code');
  const message = requiredString(value.message, 'payments failure message');
  return { code, message };
}

function statusOf(value: unknown): PayPaymentStatus {
  if (typeof value !== 'string' || !STATUSES.includes(value as PayPaymentStatus)) {
    throw new Error('payments list item status is not a payment status');
  }
  return value as PayPaymentStatus;
}

function modeOf(value: unknown): 'live' | 'sandbox' {
  if (value !== 'live' && value !== 'sandbox') throw new Error('payments list item mode is not live or sandbox');
  return value;
}

function parsePayment(value: unknown, index: number): PayPayment {
  if (!isRecord(value)) throw new Error(`payments list item ${index} is not a payment`);
  return {
    id: requiredString(value.id, `payments list item ${index} id`),
    merchantId: requiredString(value.merchantId, `payments list item ${index} merchantId`),
    profileId: nullableString(value.profileId, `payments list item ${index} profileId`),
    amount: decimal(value.amount, `payments list item ${index} amount`),
    assetId: requiredString(value.assetId, `payments list item ${index} assetId`),
    method: nullableString(value.method, `payments list item ${index} method`),
    railAdapter: nullableString(value.railAdapter, `payments list item ${index} railAdapter`),
    railRef: nullableString(value.railRef, `payments list item ${index} railRef`),
    status: statusOf(value.status),
    mode: modeOf(value.mode),
    capturedAmount: decimal(value.capturedAmount, `payments list item ${index} capturedAmount`),
    refundedAmount: decimal(value.refundedAmount, `payments list item ${index} refundedAmount`),
    createdAt: requiredString(value.createdAt, `payments list item ${index} createdAt`),
    pricingSnapshot: pricingSnapshot(value.pricingSnapshot),
    failure: failure(value.failure),
  };
}

const PAGE_SHAPE = 'GET /payments returns { items, nextCursor }';

/** Accept a 200 body that is a page. A bare array is refused. */
export function parsePaymentPage(body: unknown): PayPaymentPage {
  if (Array.isArray(body) || !isRecord(body) || !Array.isArray(body.items) || !Object.hasOwn(body, 'nextCursor')) {
    throw new Error(PAGE_SHAPE);
  }
  if (body.nextCursor !== null && typeof body.nextCursor !== 'string') {
    throw new Error('payments nextCursor is not a string');
  }
  return {
    items: body.items.map((item, index) => parsePayment(item, index)),
    nextCursor: body.nextCursor,
  };
}

export function paymentPageFromResponse(response: PayResponse): PayPaymentPage {
  if (response.status !== 200) {
    const code =
      isRecord(response.body) && isRecord(response.body.error) && typeof response.body.error.code === 'string'
        ? response.body.error.code
        : '';
    throw new Error(code ? `payments list refused: ${code}` : `payments list refused (${response.status})`);
  }
  return parsePaymentPage(response.body);
}
