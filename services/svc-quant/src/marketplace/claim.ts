import { parseAmount } from '@intafaced/ledger-client/money';
import type { SimulatedPerformanceStamp } from '@intafaced/quant-honesty';
import { QUANT_CLAIM_PNL_UNSET, QUANT_RUN_NOT_FOUND, QUANT_RUN_NOT_SIMULATED, QUANT_RUN_UNFINISHED, QuantError } from '../errors.js';
import { requireSimulatedStamp } from '../honesty.js';
import type { StoredRun } from '../runs/types.js';

export type MarketplaceClaim = SimulatedPerformanceStamp & {
  readonly ok: true;
  readonly runId: string;
  readonly pnl: string;
};

/**
 * The pnl and the stamp come from the stored run. A client pnl is not a parameter.
 * presentedAs "live" still refuses. The returned stamp is the run's stamp.
 */
export function claimFromRun(input: {
  readonly run: StoredRun | null;
  readonly callerId: string;
  readonly environment?: string | null;
  readonly presentedAs?: string | null;
}): MarketplaceClaim {
  const run = input.run;
  if (!run || run.userId !== input.callerId) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
  if (!run.finished || !run.outcome) throw new QuantError(QUANT_RUN_UNFINISHED, 'run is not finished');
  const detail = run.detail;
  if (!detail || detail.simulated !== true || detail.live !== false) {
    throw new QuantError(QUANT_RUN_NOT_SIMULATED, 'run is not a simulated result');
  }
  if (input.environment != null && input.environment.trim() !== '') {
    requireSimulatedStamp(input.environment, input.presentedAs);
  } else if (input.presentedAs != null && input.presentedAs.trim() !== '') {
    requireSimulatedStamp(detail.environment, input.presentedAs);
  }
  const stamp = requireSimulatedStamp(detail.environment, null);
  const pnl = detail.pnl?.trim() ?? '';
  if (!pnl) throw new QuantError(QUANT_CLAIM_PNL_UNSET, 'pnl is unset on the stored run — a client pnl is not accepted');
  try {
    parseAmount(pnl);
  } catch {
    throw new QuantError(QUANT_CLAIM_PNL_UNSET, 'stored pnl is not a decimal string');
  }
  return { ok: true, runId: run.id, pnl, ...stamp };
}
