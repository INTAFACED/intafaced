import type { OrderStatus } from './types.js';

/**
 * SP-lifecycle-history-01: the order state reference.
 *
 * One row per state a customer or a bot can see, each with the API value it arrives as and the plain label the
 * desk shows. The API values are the ones `toCcxtOrderStatus` emits; a test pins every stored status to a row, so a
 * new status cannot ship without a label here. Internal state names never appear.
 */
export interface OrderStateRow {
  /** The `status` on the order wire. */
  readonly apiStatus: 'open' | 'closed' | 'canceled' | 'expired' | 'rejected';
  /** What tells this row apart from the other rows with the same `status`; null when `status` alone does. */
  readonly distinguishedBy: string | null;
  /** The label the desk shows. */
  readonly customerLabel: string;
  /** One sentence, plain words. */
  readonly meaning: string;
  /** No further change is expected once an order is here. */
  readonly final: boolean;
}

export const ORDER_STATE_REFERENCE: readonly OrderStateRow[] = [
  {
    apiStatus: 'open',
    distinguishedBy: 'filled is "0"',
    customerLabel: 'Open',
    meaning: 'The order is working on the book and nothing has filled yet.',
    final: false,
  },
  {
    apiStatus: 'open',
    distinguishedBy: 'filled is above "0" and remaining is above "0"',
    customerLabel: 'Partly filled',
    meaning: 'Part of the order has filled and the rest is still working.',
    final: false,
  },
  {
    apiStatus: 'open',
    distinguishedBy: 'recoveryRequired is true',
    customerLabel: 'Being confirmed',
    meaning:
      'The reply for this order was lost. The order is checked against the book and the ledger before it is called open or closed. Do not place it again.',
    final: false,
  },
  {
    apiStatus: 'closed',
    distinguishedBy: null,
    customerLabel: 'Filled',
    meaning: 'The whole order filled.',
    final: true,
  },
  {
    apiStatus: 'canceled',
    distinguishedBy: null,
    customerLabel: 'Cancelled',
    meaning: 'The order was cancelled. Any part that had filled stays filled; the rest of the hold is given back.',
    final: true,
  },
  {
    apiStatus: 'expired',
    distinguishedBy: null,
    customerLabel: 'Expired',
    meaning: 'The order reached its stated expiry before it filled.',
    final: true,
  },
  {
    apiStatus: 'rejected',
    distinguishedBy: null,
    customerLabel: 'Rejected',
    meaning: 'The order was not accepted. `rejectCode` names the reason and no funds stay reserved.',
    final: true,
  },
];

/**
 * The owner-published length of order history. Blank means "retention not set": the page says so and no row is
 * ever cut off. A value that is not a whole number of days is reported as invalid, never guessed.
 */
export type OrderHistoryWindow =
  | { readonly status: 'not_set' }
  | { readonly status: 'published'; readonly days: number }
  | { readonly status: 'invalid'; readonly reason: string };

export const ORDER_HISTORY_WINDOW_ENV = 'ORDER_HISTORY_WINDOW' as const;

/** `ORDER_HISTORY_WINDOW` is a whole number of days as a decimal string, for example "365". */
export function parseOrderHistoryWindow(raw: string | undefined): OrderHistoryWindow {
  const text = (raw ?? '').trim();
  if (text === '') return { status: 'not_set' };
  if (!/^[1-9][0-9]{0,4}$/.test(text)) {
    return { status: 'invalid', reason: `${ORDER_HISTORY_WINDOW_ENV} must be a whole number of days, 1 or more` };
  }
  return { status: 'published', days: Number(text) };
}

/** Every stored status is covered by a row above. Used by the pin test. */
export function referenceCovers(status: OrderStatus, toApi: (s: OrderStatus) => OrderStateRow['apiStatus']): boolean {
  const api = toApi(status);
  return ORDER_STATE_REFERENCE.some((row) => row.apiStatus === api);
}

export function presentOrderStates(historyWindow: OrderHistoryWindow) {
  return {
    states: ORDER_STATE_REFERENCE,
    historyWindow,
  };
}
