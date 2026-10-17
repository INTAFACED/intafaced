/**
 * Shared pieces for the operator transfer reads.
 *
 * Counts come from rows that exist. A missing source is `available: false`
 * with a reason, never a zero. Money leaves this file as a canonical decimal
 * string. Ratios are integer division, never a float.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError, type BankErrorCode } from '../errors.js';
import { RECIPIENT_CANNOT_RECEIVE_MESSAGE } from '../spaces/space-service.js';
import type { PartyHandlePort } from '../transfers/party-handles.js';

export interface TransferOps {
  readonly sql: Sql;
  readonly handles?: PartyHandlePort;
}

export const EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KNOWN_REASONS: Readonly<Record<string, string>> = {
  'bank.recipient_cannot_receive': RECIPIENT_CANNOT_RECEIVE_MESSAGE,
};

export function assertWindowHours(windowHours: number | undefined, code: BankErrorCode, name: string): number {
  if (windowHours === undefined || !Number.isInteger(windowHours) || windowHours < 1 || windowHours > 720) {
    throw new BankError(`${name} needs windowHours from 1 to 720 (${code})`, code);
  }
  return windowHours;
}

export function windowStart(now: Date, windowHours: number): Date {
  return new Date(now.getTime() - windowHours * 60 * 60 * 1000);
}

/** Exact ratio. Null when the denominator is zero. Terminating decimals stay decimals (`3/12` is `0.25`). */
export function exactRatio(numerator: number, denominator: number): string | null {
  if (denominator === 0) return null;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || numerator > denominator) {
    throw new Error('transfer health ratio is not a count of stored rows');
  }
  return decimalRatio(BigInt(numerator), BigInt(denominator));
}

function decimalRatio(numerator: bigint, denominator: bigint): string {
  const whole = numerator / denominator;
  let rem = numerator % denominator;
  if (rem === 0n) return whole.toString();
  const digits: string[] = [];
  const seen = new Map<string, number>();
  while (rem !== 0n && digits.length < 80) {
    const key = rem.toString();
    if (seen.has(key)) return reducedFraction(numerator, denominator);
    seen.set(key, digits.length);
    rem *= 10n;
    digits.push((rem / denominator).toString());
    rem %= denominator;
  }
  while (digits.length > 0 && digits[digits.length - 1] === '0') digits.pop();
  return `${whole}.${digits.join('')}`;
}

function reducedFraction(numerator: bigint, denominator: bigint): string {
  const g = gcd(numerator, denominator);
  return `${numerator / g}/${denominator / g}`;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

export function countOf(value: number | string | bigint): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('transfer health count was not a non-negative integer');
  return n;
}

export function ageSeconds(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new Error('transfer health age was not a whole number of seconds');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('transfer health age was not a whole number of seconds');
  return n;
}

export function money(amount: string): string {
  return formatAmount(parseAmount(amount.trim()));
}

/**
 * Plain reason for a rejection code this service already states in one fixed
 * sentence. Anything else is returned as stored. A guessed sentence would
 * invent a cause the row does not carry.
 */
export function rejectionReason(code: string | null): string | null {
  if (code === null) return null;
  return KNOWN_REASONS[code] ?? code;
}
