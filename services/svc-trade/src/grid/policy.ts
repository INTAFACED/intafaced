/**
 * Owner values for the spot grid bot (CB-bots-02, CB-bots-10). Blank refuses; nothing here has a default.
 *
 * - `TRADE_GRID_COUNT_MIN` / `TRADE_GRID_COUNT_MAX`: the grid counts a user may choose. Either blank refuses every
 *   create with `trade.grid_count_range_not_set`. A grid always needs at least two levels, so a minimum below 2 stops
 *   the boot rather than allow a one-level "grid".
 * - `TRADE_GRID_PRESET_SOURCE`: where preset ranges and their backtested APR come from. No backtest source is built,
 *   so blank is the only value that boots: the presets read answers "not set" and carries no APR. Any other value stops
 *   the boot instead of pretending a source exists.
 *
 * The verification level is the shared bots level (`TRADE_BOTS_VERIFICATION_LEVEL`, algo/bots-verification.ts).
 */

export const TRADE_GRID_COUNT_MIN_ENV = 'TRADE_GRID_COUNT_MIN';
export const TRADE_GRID_COUNT_MAX_ENV = 'TRADE_GRID_COUNT_MAX';
export const TRADE_GRID_PRESET_SOURCE_ENV = 'TRADE_GRID_PRESET_SOURCE';

/** The structural floor: two price levels are the fewest a grid can trade between. */
export const GRID_COUNT_FLOOR = 2;

export interface GridPolicy {
  /** Null while either owner value is blank. */
  readonly countRange: { readonly min: number; readonly max: number } | null;
  /** Always null today: no backtest source exists. */
  readonly presetSource: null;
}

function readCount(env: Record<string, string | undefined>, key: string): number | null {
  const raw = env[key]?.trim() ?? '';
  if (raw === '') return null;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a whole number (got ${JSON.stringify(raw)}); refusing to boot`);
  return Number(raw);
}

export function loadGridPolicy(env: Record<string, string | undefined>): GridPolicy {
  const min = readCount(env, TRADE_GRID_COUNT_MIN_ENV);
  const max = readCount(env, TRADE_GRID_COUNT_MAX_ENV);
  if (min !== null && min < GRID_COUNT_FLOOR) {
    throw new Error(`${TRADE_GRID_COUNT_MIN_ENV} must be at least ${GRID_COUNT_FLOOR} (got ${min}); refusing to boot`);
  }
  if (min !== null && max !== null && max < min) {
    throw new Error(`${TRADE_GRID_COUNT_MAX_ENV} (${max}) is below ${TRADE_GRID_COUNT_MIN_ENV} (${min}); refusing to boot`);
  }
  const source = env[TRADE_GRID_PRESET_SOURCE_ENV]?.trim() ?? '';
  if (source !== '') {
    throw new Error(`${TRADE_GRID_PRESET_SOURCE_ENV} is set, but no grid backtest source is built; leave it blank. Refusing to boot`);
  }
  return { countRange: min !== null && max !== null ? { min, max } : null, presetSource: null };
}
