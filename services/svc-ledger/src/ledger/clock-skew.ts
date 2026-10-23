import type { Sql } from 'postgres';
import { WRITES_BLOCKED_CLOCK_SKEW } from './write-block.js';

export { WRITES_BLOCKED_CLOCK_SKEW };

/**
 * Clock-skew write block (OPS-ledger-desk-04, the part left after the store codes).
 *
 * The owner sets `LEDGER_CLOCK_SKEW_BOUND_MS` as a non-negative integer string of
 * milliseconds. Blank is not a bound: the integrity read refuses
 * `ledger.skew_bound_unset` and does not treat blank as 0 (every write blocked)
 * or as unlimited (every write allowed). Explicit `0` is a real bound: any
 * positive difference blocks. A set bound that the clocks exceed refuses a post
 * with `ledger.writes_blocked_clock_skew` before the engine books anything.
 */

export const SKEW_BOUND_UNSET = 'ledger.skew_bound_unset' as const;

export type ClockSkewCode = typeof SKEW_BOUND_UNSET | typeof WRITES_BLOCKED_CLOCK_SKEW;

export type ClockSkewView = {
  readonly ok: boolean;
  readonly code: ClockSkewCode | null;
  /** Null when the owner has not set a bound. Never a made-up number. */
  readonly boundMs: string | null;
  readonly skewMs: string;
  readonly appNow: string;
  readonly databaseNow: string;
};

const INTEGER_MS = /^(0|[1-9][0-9]*)$/;

/** Blank or unset is null. Anything else must be a non-negative integer string. */
export function parseClockSkewBoundMs(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error('LEDGER_CLOCK_SKEW_BOUND_MS must be a non-negative integer string or blank');
  }
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!INTEGER_MS.test(trimmed)) {
    throw new Error('LEDGER_CLOCK_SKEW_BOUND_MS must be a non-negative integer string or blank');
  }
  const bound = Number(trimmed);
  if (!Number.isSafeInteger(bound)) {
    throw new Error('LEDGER_CLOCK_SKEW_BOUND_MS is outside the safe integer range');
  }
  return bound;
}

export function assessClockSkew(input: {
  readonly boundMs: number | null;
  readonly appNow: Date;
  readonly databaseNow: Date;
}): ClockSkewView {
  const skew = BigInt(input.appNow.getTime()) - BigInt(input.databaseNow.getTime());
  const abs = skew < 0n ? -skew : skew;
  const view = {
    skewMs: abs.toString(),
    appNow: input.appNow.toISOString(),
    databaseNow: input.databaseNow.toISOString(),
  };
  if (input.boundMs === null) {
    return { ok: false, code: SKEW_BOUND_UNSET, boundMs: null, ...view };
  }
  const bound = BigInt(input.boundMs);
  if (abs > bound) {
    return { ok: false, code: WRITES_BLOCKED_CLOCK_SKEW, boundMs: bound.toString(), ...view };
  }
  return { ok: true, code: null, boundMs: bound.toString(), ...view };
}

export async function readDatabaseNow(sql: Sql): Promise<Date> {
  const [row] = await sql<{ at: Date | string }[]>`select clock_timestamp() as at`;
  const at = row?.at;
  const instant = at instanceof Date ? at : typeof at === 'string' ? new Date(at) : null;
  if (!instant || Number.isNaN(instant.getTime())) {
    throw Object.assign(new Error('clock_timestamp returned no instant'), { code: '08006' });
  }
  return instant;
}
