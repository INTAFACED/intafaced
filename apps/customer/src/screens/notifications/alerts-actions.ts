import type { ApiClient } from '../../shared/api';
import { cancelWords, settleFailure, type CancelWords, type Settled } from './alerts-model';
import { cancelPriceAlert, createPriceAlert, type AlertEvaluation, type AlertIntent, type PriceAlert } from './notify-api';

export type CreateOutcome = { kind: 'saved'; alert: PriceAlert; evaluation: AlertEvaluation } | Settled;
export type CancelOutcome = { kind: 'done'; words: CancelWords; alert: PriceAlert | null } | Settled;

/**
 * Save one price alert. The service takes no request id, so this is sent at most once per call and the caller must not call it
 * again for the same intent until the list shows whether the first attempt landed (see `settleUnknownCreate`).
 */
export async function submitCreate(api: ApiClient, intent: AlertIntent, userId: string): Promise<CreateOutcome> {
  const result = await createPriceAlert(api, intent, userId);
  return result.ok ? { kind: 'saved', alert: result.data.alert, evaluation: result.data.evaluation } : settleFailure(result);
}

/** Cancel one alert. Cancelling twice is harmless, so a lost answer may be retried after the list is read. */
export async function submitCancel(api: ApiClient, id: string, userId: string): Promise<CancelOutcome> {
  const result = await cancelPriceAlert(api, id, userId);
  return result.ok ? { kind: 'done', words: cancelWords(result.data), alert: result.data.alert } : settleFailure(result);
}
