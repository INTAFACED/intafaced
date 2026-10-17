/**
 * GET /payment-links page.
 *
 * The wire body is `{ items, nextCursor }`. `nextCursor` is null on the last
 * page. An amount is a decimal string or null. A JSON number is refused.
 */
import type { PayResponse } from './client.js';

const AMOUNT = /^\d+(\.\d{1,18})?$/;
const PAGE_SHAPE = 'GET /payment-links returns { items, nextCursor }';

export interface PayPaymentLink {
  readonly id: string;
  readonly prefix: string;
  readonly label: string;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly active: boolean;
  readonly expiresAt: string | null;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly createdAt: string;
}

export interface PayPaymentLinkPage {
  readonly items: readonly PayPaymentLink[];
  readonly nextCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function amountOf(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !AMOUNT.test(value)) throw new Error(`${label} must be a decimal string`);
  return value;
}

function integerOf(value: unknown, label: string, nullable: boolean): number | null {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} is not an integer`);
  return value;
}

function parseLink(value: unknown, index: number): PayPaymentLink {
  if (!isRecord(value)) throw new Error(`payment links list item ${index} is not a link`);
  if (typeof value.active !== 'boolean') throw new Error(`payment links list item ${index} active is not a boolean`);
  return {
    id: requiredString(value.id, `payment links list item ${index} id`),
    prefix: requiredString(value.prefix, `payment links list item ${index} prefix`),
    label: requiredString(value.label, `payment links list item ${index} label`),
    amount: amountOf(value.amount, `payment links list item ${index} amount`),
    currency: nullableString(value.currency, `payment links list item ${index} currency`),
    active: value.active,
    expiresAt: nullableString(value.expiresAt, `payment links list item ${index} expiresAt`),
    maxUses: integerOf(value.maxUses, `payment links list item ${index} maxUses`, true),
    uses: integerOf(value.uses, `payment links list item ${index} uses`, false) ?? 0,
    createdAt: requiredString(value.createdAt, `payment links list item ${index} createdAt`),
  };
}

/** Accept a 200 body that is a page. A bare array is refused. */
export function parsePaymentLinkPage(body: unknown): PayPaymentLinkPage {
  if (Array.isArray(body) || !isRecord(body) || !Array.isArray(body.items) || !Object.hasOwn(body, 'nextCursor')) {
    throw new Error(PAGE_SHAPE);
  }
  if (body.nextCursor !== null && typeof body.nextCursor !== 'string') {
    throw new Error('payment links nextCursor is not a string');
  }
  return {
    items: body.items.map((item, index) => parseLink(item, index)),
    nextCursor: body.nextCursor,
  };
}

export function paymentLinkPageFromResponse(response: PayResponse): PayPaymentLinkPage {
  if (response.status !== 200) {
    const code =
      isRecord(response.body) && isRecord(response.body.error) && typeof response.body.error.code === 'string'
        ? response.body.error.code
        : '';
    throw new Error(code ? `payment links list refused: ${code}` : `payment links list refused (${response.status})`);
  }
  return parsePaymentLinkPage(response.body);
}
