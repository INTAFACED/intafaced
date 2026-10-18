/**
 * REST body for `FuturesError`.
 *
 * Operator-config codes stay domain `{ error, message }` but carry `ccxtCode:
 * NotSupported` and `retry: false`. HTTP is 403 (same as `trade.futures_disabled`)
 * so CCXT transports do not retry 5xx. These are not venue-down: an operator
 * names the profit pot.
 *
 * Other FuturesError codes keep the historical two-field body — do not invent
 * a retry class for marks / locks here.
 */

export const OPERATOR_PROFIT_POT_CODES = ['trade.futures_unconfigured', 'trade.profit_source_unconfigured'] as const;

export type OperatorProfitPotCode = (typeof OPERATOR_PROFIT_POT_CODES)[number];

export function isOperatorProfitPotCode(code: string): code is OperatorProfitPotCode {
  return (OPERATOR_PROFIT_POT_CODES as readonly string[]).includes(code);
}

export function presentFuturesErrorWire(err: { code: string; message: string; rung?: 'closing' | 'partial'; addMarginAllowed?: boolean }): {
  error: string;
  message: string;
  ccxtCode?: 'NotSupported';
  retry?: false;
  rung?: 'closing' | 'partial';
  addMarginAllowed?: boolean;
} {
  const body: {
    error: string;
    message: string;
    ccxtCode?: 'NotSupported';
    retry?: false;
    rung?: 'closing' | 'partial';
    addMarginAllowed?: boolean;
  } = { error: err.code, message: err.message };
  if (isOperatorProfitPotCode(err.code)) {
    body.ccxtCode = 'NotSupported';
    body.retry = false;
  }
  if (err.rung !== undefined) body.rung = err.rung;
  if (err.addMarginAllowed !== undefined) body.addMarginAllowed = err.addMarginAllowed;
  return body;
}

/** A mark refusal that rolled back. 409 plus `committed: false`, so a client does not treat it as an unknown outcome. */
export function isRolledBackMarkRefusal(code: string): boolean {
  return code === 'trade.mark_missing' || code === 'trade.mark_unusable';
}

export function presentRolledBackRefusal(err: { code: string; message: string }): {
  error: string;
  message: string;
  committed: false;
} {
  return { error: err.code, message: err.message, committed: false };
}
