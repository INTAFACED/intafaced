import type { ApiClient } from '../../shared/api';
import { activeWords, cancelWords, settleFailure, type ActiveWords, type CancelWords, type Settled } from './alerts-model';
import {
  cancelPriceAlert,
  createPriceAlert,
  deletePriceAlert,
  setPriceAlertActive,
  updatePriceAlert,
  type AlertEdit,
  type AlertEvaluation,
  type AlertIntent,
  type PriceAlert,
} from './notify-api';

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

export type EditOutcome = { kind: 'edited'; alert: PriceAlert } | Settled;
export type ActiveOutcome = { kind: 'done'; words: ActiveWords; alert: PriceAlert } | Settled;
export type DeleteOutcome = { kind: 'deleted'; deleted: boolean } | Settled;

/** Change an alert. It sets values, so after a lost answer the list is read and the person may send it again. */
export async function submitEdit(api: ApiClient, id: string, edit: AlertEdit, userId: string): Promise<EditOutcome> {
  const result = await updatePriceAlert(api, id, edit, userId);
  return result.ok ? { kind: 'edited', alert: result.data.alert } : settleFailure(result);
}

/** Pause or resume. What happened is read from the status the service sent back, not from `changed`. */
export async function submitActive(api: ApiClient, id: string, active: boolean, userId: string): Promise<ActiveOutcome> {
  const result = await setPriceAlertActive(api, id, active, userId);
  return result.ok ? { kind: 'done', words: activeWords(result.data.alert), alert: result.data.alert } : settleFailure(result);
}

/** Delete an alert. Deleting twice is harmless, so a lost answer may be retried after the list is read. */
export async function submitDelete(api: ApiClient, id: string): Promise<DeleteOutcome> {
  const result = await deletePriceAlert(api, id);
  return result.ok ? { kind: 'deleted', deleted: result.data.deleted } : settleFailure(result);
}
