/**
 * Account position mode.
 *
 * VERIFIED against `drizzle/0003_trade_futures_positions.sql`: the open unique
 * index is `(user_id, market_id, side, margin_mode)`. A long and a short are
 * two rows on one market. `pretrade-limits.ts` already treats `hedge` as
 * "each side is its own position". The book therefore keys more than one
 * position per market per account, so hedge is a stored mode.
 *
 * `BOOK_KEYS_MORE_THAN_ONE_PER_MARKET` is that verification. When it is false,
 * hedge refuses `trade.position_mode_hedge_unsupported` and the read is
 * one-way with source `fixed`. The live constant is true.
 */
export const BOOK_KEYS_MORE_THAN_ONE_PER_MARKET = true;

export const POSITION_MODE_UNSET = 'trade.position_mode_unset' as const;
export const POSITION_MODE_HEDGE_UNSUPPORTED = 'trade.position_mode_hedge_unsupported' as const;
export const POSITION_MODE_MIGRATION_BLOCKED = 'trade.position_mode_migration_blocked' as const;
export const POSITION_MODE_UNSUPPORTED = 'trade.position_mode_unsupported' as const;
export const POSITION_MODE_CONFLICT = 'trade.position_mode_conflict' as const;

export type AccountModeName = 'one_way' | 'hedge';

export interface StoredAccountMode {
  readonly mode: AccountModeName;
  readonly source: 'stored';
  readonly clientModeId: string;
}

export type AccountModeRead =
  | { readonly mode: 'one_way'; readonly source: 'fixed' }
  | { readonly mode: AccountModeName; readonly source: 'stored'; readonly clientModeId: string }
  | { readonly mode: null; readonly source: 'unset'; readonly code: typeof POSITION_MODE_UNSET };

export function presentAccountMode(
  stored: StoredAccountMode | null,
  bookKeysMultiple: boolean = BOOK_KEYS_MORE_THAN_ONE_PER_MARKET,
): AccountModeRead {
  if (!bookKeysMultiple) return { mode: 'one_way', source: 'fixed' };
  if (!stored) return { mode: null, source: 'unset', code: POSITION_MODE_UNSET };
  return stored;
}

export type ModeWriteDecision =
  | { readonly ok: true; readonly mode: AccountModeName; readonly changed: boolean }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export function decideModeWrite(
  input: {
    readonly current: AccountModeName | null;
    readonly next: unknown;
    readonly openPositionCount: number;
    readonly sameClientKey: boolean;
  },
  bookKeysMultiple: boolean = BOOK_KEYS_MORE_THAN_ONE_PER_MARKET,
): ModeWriteDecision {
  if (input.next !== 'one_way' && input.next !== 'hedge') {
    return {
      ok: false,
      code: POSITION_MODE_UNSUPPORTED,
      reason: 'position mode must be one_way or hedge',
    };
  }
  if (input.next === 'hedge' && !bookKeysMultiple) {
    return {
      ok: false,
      code: POSITION_MODE_HEDGE_UNSUPPORTED,
      reason: 'hedge mode is unsupported — the position book does not key more than one position per market per account',
    };
  }
  if (input.sameClientKey && input.current != null && input.current !== input.next) {
    return {
      ok: false,
      code: POSITION_MODE_CONFLICT,
      reason: 'this clientModeId already stored a different mode',
    };
  }
  if (input.current === input.next) return { ok: true, mode: input.next, changed: false };
  if (input.openPositionCount > 0) {
    return {
      ok: false,
      code: POSITION_MODE_MIGRATION_BLOCKED,
      reason: 'switching position mode with open positions refuses — will not invent a flatten',
    };
  }
  return { ok: true, mode: input.next, changed: true };
}
