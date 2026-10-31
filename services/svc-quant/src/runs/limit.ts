import {
  QUANT_OPS_RUNS_FROM_UNSET,
  QUANT_OPS_RUNS_LIMIT_UNSET,
  QUANT_OPS_RUNS_TO_UNSET,
  QUANT_RUN_RESULT_CAP_UNSET,
  QUANT_RUN_RESULT_TOO_LARGE,
  QuantError,
} from '../errors.js';

/** Published byte cap for one run result. Not read from the environment. */
export const RUN_RESULT_MAX_BYTES = 262_144;

/**
 * What one run in progress holds against the plan until it finishes (AL-limits-01): the largest result it may store,
 * and the most log lines that result can hold (each line is a JSON string of at least two bytes, its quotes).
 */
export const RUN_RESERVE = { bytes: BigInt(RUN_RESULT_MAX_BYTES), logLines: BigInt(Math.floor(RUN_RESULT_MAX_BYTES / 2)) } as const;

export const OPS_RUNS_LIMIT_CAP = 50;

/** Blank is refused. 262144 is not assumed when the caller omits the cap. */
export function assertRunResultCap(cap: number | null | undefined): number {
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1) {
    throw new QuantError(QUANT_RUN_RESULT_CAP_UNSET, 'run result cap is unset — a byte cap is not invented');
  }
  return cap;
}

export function assertResultFits(body: unknown, cap: number): void {
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > cap) {
    throw new QuantError(QUANT_RUN_RESULT_TOO_LARGE, `run result is ${bytes} bytes and the cap is ${cap}`);
  }
}

/** Blank is refused. 50 is a ceiling, not a fill-in for an omitted limit. */
export function assertOpsRunsLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new QuantError(QUANT_OPS_RUNS_LIMIT_UNSET, 'ops.runs limit is unset');
  }
  const n = Math.floor(limit);
  if (n < 1) throw new QuantError(QUANT_OPS_RUNS_LIMIT_UNSET, 'ops.runs limit is unset');
  return Math.min(OPS_RUNS_LIMIT_CAP, n);
}

export function requireWindowBound(value: string | null | undefined, which: 'from' | 'to'): string {
  const text = value?.trim() ?? '';
  const code = which === 'from' ? QUANT_OPS_RUNS_FROM_UNSET : QUANT_OPS_RUNS_TO_UNSET;
  if (!text) throw new QuantError(code, `ops.runCounts ${which} is unset`);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new QuantError('quant.params_invalid', `ops.runCounts ${which} is not a timestamp`);
  return new Date(parsed).toISOString();
}

export function optionalWindowBound(value: string | null | undefined, which: 'from' | 'to'): string | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new QuantError('quant.params_invalid', `ops.runs ${which} is not a timestamp`);
  return new Date(parsed).toISOString();
}
