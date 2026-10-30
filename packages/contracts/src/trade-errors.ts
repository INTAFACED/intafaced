/**
 * The order errors the trading REST API (`/api/v1`) links to its error page, published at `/developers/errors`
 * (DV-errors-01, DV-errors-02). One entry per code a create, batch or replace body refusal, or the platform posting
 * freeze, can answer with: the body `code` a client branches on (CCXT's error class), the HTTP status, and the
 * `intafacedCode` that names the decision.
 *
 * svc-trade's tests hold its bodies to this list (`trade-errors-catalogue.test.ts`): every code its create-body refusal
 * links with `docs` is here with the same status and class, and each freeze code is the one its CCXT mapping sends.
 * `anchor` is the entry's fragment on the page; a refusal's `docs` link is `/developers/errors#<intafacedCode>`.
 */

export const TRADE_ERRORS_PATH = '/developers/errors' as const;

export type TradeErrorCause = 'fields' | 'tag' | 'posting_frozen' | 'settlement_pending';

export interface TradeErrorEntry {
  readonly cause: TradeErrorCause;
  /** The body `code`, what a client branches on. */
  readonly code: string;
  readonly status: 400 | 503;
  /** The decision behind the code, sent beside it as `intafacedCode`. */
  readonly intafacedCode: string;
  readonly anchor: string;
}

const entry = (cause: TradeErrorCause, code: string, status: TradeErrorEntry['status'], intafacedCode: string): TradeErrorEntry => ({
  cause,
  code,
  status,
  intafacedCode,
  anchor: intafacedCode,
});

export const TRADE_ERROR_CATALOGUE: readonly TradeErrorEntry[] = [
  entry('fields', 'InvalidOrder', 400, 'trade.validation_failed'),
  entry('tag', 'InvalidOrder', 400, 'trade.invalid_tag'),
  entry('posting_frozen', 'OnMaintenance', 400, 'posting_frozen'),
  entry('settlement_pending', 'ExchangeNotAvailable', 503, 'trade.settlement_pending'),
];

/** Where a refusal with this `intafacedCode` is explained: its entry's anchor on the page. */
export function tradeErrorDocsLink(intafacedCode: string): string {
  return `${TRADE_ERRORS_PATH}#${intafacedCode}`;
}
