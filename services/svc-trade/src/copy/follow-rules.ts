/**
 * The follower's own copy rules (CB-copy-05, CB-copy-06; J-copy-bots-otc-02 #1 to #3): how each copy is sized, the most
 * per contract, the most per owner day, and the owner's minimum investment.
 *
 * Limits, never money: nothing here posts or holds. The caps limit new mirrors only (a buy, which opens); a leader's
 * close still runs down what was copied. Every check runs in our policy before the copy is placed under the follower's
 * permission. A blank owner value refuses with a typed error; it never becomes a default.
 */
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { CopyError } from './errors.js';

/** The sizing modes a follow may ask for. Only fixed amount and smart sync are offered. */
export const COPY_SIZING_MODES = ['fixed_amount', 'smart_sync', 'multiplier'] as const;
export type CopySizingModeInput = (typeof COPY_SIZING_MODES)[number];
export type CopySizingMode = Exclude<CopySizingModeInput, 'multiplier'>;

/**
 * Smart sync sizes each copy as the leader's order scaled by the follower's total over the leader's own balance in the
 * quote asset, both read when the follow starts and kept with it, so a copy's size never depends on a later reading.
 */
export type CopySmartSync = { readonly followerTotal: Amount; readonly leaderEquity: Amount };

/** The mode a follow asked for; multiplier is refused (the owner has not decided it). Omitted means fixed amount. */
export function parseCopySizingMode(raw: string | null | undefined): CopySizingMode {
  const mode = raw === undefined || raw === null || raw === '' ? 'fixed_amount' : raw;
  if (mode === 'multiplier') {
    throw new CopyError('Multiplier sizing is not offered: the platform has not decided it.', 'trade.copy_mode_owner_decision');
  }
  if (mode !== 'fixed_amount' && mode !== 'smart_sync') {
    throw new CopyError(`Unknown sizing mode ${String(raw)}`, 'trade.copy_envelope_invalid');
  }
  return mode;
}

/** The smart-sync ratio from the two readings. A leader with nothing in the quote asset can't be synced to. */
export function copySmartSyncFrom(followerTotal: Amount, leaderEquity: Amount): CopySmartSync {
  if (leaderEquity <= 0n) {
    throw new CopyError(
      'Smart sync needs the leader’s balance, and the leader holds none in this asset now. Use a fixed amount.',
      'trade.copy_smart_sync_unavailable',
    );
  }
  return { followerTotal, leaderEquity };
}

/** An optional positive cap: blank (or omitted) means not set. */
export function parseOptionalCopyCap(raw: string | null | undefined, label: string): Amount | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  let amount: Amount;
  try {
    amount = parseAmount(trimmed);
  } catch {
    throw new CopyError(`${label} must be a decimal amount`, 'trade.copy_envelope_invalid');
  }
  if (amount <= 0n) throw new CopyError(`${label} must be more than zero`, 'trade.copy_envelope_invalid');
  return amount;
}

/**
 * The owner's minimum investment (`TRADE_COPY_MIN_INVESTMENT`, in the quote asset). Blank is unpublished: every follow
 * refuses with `trade.copy_min_not_set`.
 */
export type CopyMinInvestment = { readonly published: true; readonly amount: Amount } | { readonly published: false };

export function parseCopyMinInvestment(raw: string | undefined): CopyMinInvestment {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { published: false };
  let amount: Amount;
  try {
    amount = parseAmount(trimmed);
  } catch {
    throw new Error('TRADE_COPY_MIN_INVESTMENT must be a decimal amount or blank');
  }
  if (amount <= 0n) throw new Error('TRADE_COPY_MIN_INVESTMENT must be more than zero or blank');
  return { published: true, amount };
}

export function assertCopyMinInvestment(min: CopyMinInvestment, total: Amount, asset: string): void {
  if (!min.published) {
    throw new CopyError('The platform hasn’t set the minimum investment for a copy, so no copy can start.', 'trade.copy_min_not_set');
  }
  if (total < min.amount) {
    throw new CopyError(
      `The most in total is below the minimum investment of ${formatAmount(min.amount)} ${asset}.`,
      'trade.copy_below_min_investment',
    );
  }
}

/**
 * The owner day (`TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES`): a day starts at local midnight for that offset from UTC.
 * Blank is unset: a daily cap then can't be counted, so a follow with one refuses (`trade.copy_day_not_set`).
 */
export type CopyOwnerDay = { readonly published: true; readonly offsetMinutes: number } | { readonly published: false };

export function parseCopyOwnerDay(raw: string | undefined): CopyOwnerDay {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { published: false };
  if (!/^[+-]?\d{1,4}$/.test(trimmed)) throw new Error('TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES must be whole minutes or blank');
  const offsetMinutes = Number(trimmed);
  if (offsetMinutes < -720 || offsetMinutes > 840) {
    throw new Error('TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES must be between -720 and 840');
  }
  return { published: true, offsetMinutes };
}

/** The owner day `now` falls in: its start and the next day's start. */
export function copyOwnerDay(day: CopyOwnerDay, now: Date): { start: Date; next: Date } {
  if (!day.published) {
    throw new CopyError('The platform hasn’t set when a copy day starts, so a daily cap can’t be counted.', 'trade.copy_day_not_set');
  }
  const shift = day.offsetMinutes * 60_000;
  const local = now.getTime() + shift;
  const startLocal = local - (((local % 86_400_000) + 86_400_000) % 86_400_000);
  const start = new Date(startLocal - shift);
  return { start, next: new Date(start.getTime() + 86_400_000) };
}

/** What a new copy would add on top of what this follow already copied: the per-contract and the daily cap. */
export function assertCopyCaps(input: {
  readonly notional: Amount;
  readonly maxPerMarket?: Amount;
  readonly marketUsed: Amount;
  readonly maxPerDay?: Amount;
  readonly dayUsed: Amount;
  readonly marketId: string;
  readonly asset: string;
  readonly nextDay?: Date;
}): void {
  if (input.maxPerMarket !== undefined && input.marketUsed + input.notional > input.maxPerMarket) {
    throw new CopyError(
      `This copy would take ${input.marketId} past your most per contract, ${formatAmount(input.maxPerMarket)} ${input.asset}.`,
      'trade.copy_market_cap_reached',
    );
  }
  if (input.maxPerDay !== undefined && input.dayUsed + input.notional > input.maxPerDay) {
    throw new CopyError(
      `This copy would take today past your most per day, ${formatAmount(input.maxPerDay)} ${input.asset}` +
        (input.nextDay ? `; copying resumes at ${input.nextDay.toISOString()}.` : '.'),
      'trade.copy_daily_cap_reached',
    );
  }
}
