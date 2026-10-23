import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import type { SpendPeriod } from './gate.js';

const PERIODS: readonly SpendPeriod[] = ['day', 'week', 'month'];

export interface ParsedSpendLimit {
  readonly assetId: string;
  readonly perCall: Amount;
  readonly perSession: Amount;
  readonly perPeriod: Amount;
  readonly period: SpendPeriod;
  readonly idempotencyKey: string;
}

function blank(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

function unset(what: string): AgentError {
  return new AgentError(
    `${what} is blank — refusing rather than inventing a spend limit`,
    'agents.spend_limit_unset',
    'agents.refused.spend_limit_unset',
  );
}

function invalid(what: string): AgentError {
  return new AgentError(`${what} is not a usable spend limit`, 'agents.spend_limit_invalid', 'agents.refused.spend_limit_invalid');
}

/** Unsigned decimal. Blank is unset. Negative, junk, and extra scale are invalid. Never coerces. */
export function parseSpendAmount(raw: string | null | undefined, field: string): Amount {
  if (blank(raw)) throw unset(field);
  try {
    const parsed = parseAmount(raw!.trim());
    if (parsed < 0n) throw invalid(field);
    return parsed;
  } catch (err) {
    if (err instanceof AgentError) throw err;
    throw invalid(field);
  }
}

export function parseSpendLimitInput(input: {
  assetId?: string | null;
  perCall?: string | null;
  perSession?: string | null;
  perPeriod?: string | null;
  period?: string | null;
  idempotencyKey?: string | null;
}): ParsedSpendLimit {
  if (blank(input.assetId)) throw unset('asset');
  if (blank(input.period)) throw unset('period');
  if (blank(input.idempotencyKey)) throw invalid('idempotency key');
  const assetId = input.assetId!.trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(assetId)) throw invalid('asset');
  const period = input.period!.trim();
  if (!PERIODS.includes(period as SpendPeriod)) throw invalid('period');
  const idempotencyKey = input.idempotencyKey!.trim();
  if (idempotencyKey.length > 200) throw invalid('idempotency key');
  return {
    assetId,
    perCall: parseSpendAmount(input.perCall, 'per-call limit'),
    perSession: parseSpendAmount(input.perSession, 'per-session limit'),
    perPeriod: parseSpendAmount(input.perPeriod, 'per-period limit'),
    period: period as SpendPeriod,
    idempotencyKey,
  };
}

/** UTC bucket start. Week starts Monday. The caller supplies the clock. */
export function periodStart(period: SpendPeriod, now: Date): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === 'day') return new Date(Date.UTC(y, m, d));
  if (period === 'month') return new Date(Date.UTC(y, m, 1));
  const weekday = now.getUTCDay();
  const sinceMonday = weekday === 0 ? 6 : weekday - 1;
  return new Date(Date.UTC(y, m, d - sinceMonday));
}

export type SpendScope = 'call' | 'session' | 'period';

/**
 * Equal to the cap is allowed. Over is not. Sums are scaled bigint.
 * A blank cap never reaches here — the caller refused it already.
 */
export function decideReservation(input: {
  perCall: Amount;
  perSession: Amount;
  perPeriod: Amount;
  sessionUsed: Amount;
  periodUsed: Amount;
  amount: Amount;
}): { readonly ok: true } | { readonly ok: false; readonly scope: SpendScope; readonly cap: Amount } {
  if (input.amount > input.perCall) return { ok: false, scope: 'call', cap: input.perCall };
  if (input.sessionUsed + input.amount > input.perSession) return { ok: false, scope: 'session', cap: input.perSession };
  if (input.periodUsed + input.amount > input.perPeriod) return { ok: false, scope: 'period', cap: input.perPeriod };
  return { ok: true };
}

export function canonicalAmount(value: Amount): string {
  return formatAmount(value);
}
