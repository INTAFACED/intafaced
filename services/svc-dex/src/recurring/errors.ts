/** Typed refusals for recurring buys (D-limit-dca-05). The code leads the message on the wire. */
export const recurringCodes = {
  unwired: 'dex.recurring.unwired',
  retryWindowUnset: 'dex.recurring.retry_window_unset',
  badRequest: 'dex.recurring.bad_request',
  notFound: 'dex.recurring.not_found',
  notEditable: 'dex.recurring.not_editable',
  closed: 'dex.recurring.closed',
} as const;
export type RecurringCode = (typeof recurringCodes)[keyof typeof recurringCodes];

export class RecurringRefused extends Error {
  constructor(
    readonly code: RecurringCode,
    message: string,
  ) {
    super(message);
    this.name = 'RecurringRefused';
  }
}

export function refuseRecurring(code: RecurringCode, message: string): never {
  throw new RecurringRefused(code, message);
}
