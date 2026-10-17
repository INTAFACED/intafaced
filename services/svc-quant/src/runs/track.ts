import { QUANT_RUN_IMMUTABLE, QUANT_RUN_RESULT_TOO_LARGE, QuantError, type QuantCode } from '../errors.js';
import type { BeginRun, RunRepository } from './repository.js';
import type { StoredRunResult } from './types.js';

function throwOutcome(outcome: string): never {
  throw new QuantError(outcome as QuantCode, 'replay of a refused run');
}

/**
 * One row per client key. The runner inserts it, then sets finished and outcome
 * once. A second call returns the first success or the first refusal.
 */
export async function trackRun<T>(
  runs: RunRepository,
  begin: BeginRun,
  exec: () => Promise<T>,
  storedOf: (value: T, err: unknown) => StoredRunResult,
): Promise<T> {
  const existing = await runs.replay(begin.userId, begin.idempotencyKey);
  if (existing?.finished) {
    if (existing.outcome !== 'ok') throwOutcome(existing.outcome ?? 'quant.params_invalid');
    return existing.response as T;
  }
  const row = existing ?? (await runs.begin(begin));
  if (row.finished) {
    if (row.outcome !== 'ok') throwOutcome(row.outcome ?? 'quant.params_invalid');
    return row.response as T;
  }
  try {
    const value = await exec();
    try {
      await runs.finish({ id: row.id, userId: begin.userId, outcome: 'ok', stored: storedOf(value, null) });
    } catch (sizeErr) {
      if (sizeErr instanceof QuantError && sizeErr.code === QUANT_RUN_RESULT_TOO_LARGE) {
        await runs.finish({
          id: row.id,
          userId: begin.userId,
          outcome: QUANT_RUN_RESULT_TOO_LARGE,
          stored: { detail: null, response: null },
        });
      }
      throw sizeErr;
    }
    return value;
  } catch (err) {
    if (err instanceof QuantError && err.code === QUANT_RUN_RESULT_TOO_LARGE) throw err;
    const outcome = err instanceof QuantError ? err.code : 'quant.params_invalid';
    try {
      await runs.finish({ id: row.id, userId: begin.userId, outcome, stored: storedOf(null as T, err) });
    } catch (finishErr) {
      if (!(finishErr instanceof QuantError) || finishErr.code !== QUANT_RUN_IMMUTABLE) throw finishErr;
    }
    throw err;
  }
}
