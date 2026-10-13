import { parseAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { holdingsFromBalances, needsPrices, valuePortfolio, type PortfolioSummary, type TickerMap, type TickerQuote } from './valuation.js';

/**
 * PORTFOLIO SUMMARY — one server-computed "Est. total value" (UI-SPEC §1.2, U3).
 *
 * Balances come from the ledger (`ledger.balances('user', userId)`, the same
 * read svc-trade's `/api/v1/account/balance` projects). Prices come from
 * svc-trade's public `GET /api/v1/tickers`, a READ of another stream's public
 * surface: no import, no shared table, nothing written back. The rule itself
 * lives in `valuation.ts`.
 *
 * If prices are needed and cannot be had, the call REFUSES `bank.prices_unavailable`.
 * A total that silently left out the coins it could not price would be a wrong
 * number with a plausible face. A user who holds only USDT, USDC or USD needs
 * no price, so that case is answered even while svc-trade is down.
 */

/** The port. One method: the current tickers, keyed by unified symbol. Throws on any failure. */
export interface TickerSource {
  tickers(): Promise<TickerMap>;
}

export const DEFAULT_TICKER_TIMEOUT_MS = 3_000;
/** svc-trade's cap on `/tickers?limit=` (MAX_MARKETS). The limit is required, never defaulted by the server. */
export const TICKER_LIMIT = 500;

function unavailable(reason: string): BankError {
  return new BankError(`Prices are unavailable right now, so a total cannot be shown (${reason})`, 'bank.prices_unavailable');
}

function amountOrNull(v: unknown): Amount | null {
  if (typeof v !== 'string') return null;
  try {
    return parseAmount(v);
  } catch {
    return null;
  }
}

/** svc-trade's public tickers over HTTP, with a hard timeout. */
export function httpTickerSource(options: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }): TickerSource {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TICKER_TIMEOUT_MS;
  const base = options.baseUrl.replace(/\/$/, '');

  return {
    async tickers() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let body: unknown;
      try {
        const res = await doFetch(`${base}/api/v1/tickers?limit=${TICKER_LIMIT}`, { signal: controller.signal });
        if (!res.ok) throw unavailable(`trade answered ${res.status}`);
        body = await res.json();
      } catch (err) {
        if (err instanceof BankError) throw err;
        throw unavailable(controller.signal.aborted ? 'trade timed out' : 'trade unreachable');
      } finally {
        clearTimeout(timer);
      }

      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw unavailable('trade sent an unexpected answer');
      const out = new Map<string, TickerQuote>();
      for (const [symbol, raw] of Object.entries(body as Record<string, unknown>)) {
        if (raw === null || typeof raw !== 'object') continue;
        const t = raw as Record<string, unknown>;
        out.set(symbol.toUpperCase(), {
          last: amountOrNull(t.last),
          open: amountOrNull(t.open),
          windowStart: typeof t.windowStart === 'number' && Number.isFinite(t.windowStart) ? t.windowStart : null,
        });
      }
      return out;
    },
  };
}

export interface PortfolioServiceOptions {
  /** Unset = no price counterparty: any user who holds a priced asset gets `bank.prices_unavailable`. */
  tickers?: TickerSource;
  now?: () => Date;
}

export class PortfolioService {
  private readonly tickers: TickerSource | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly ledger: Pick<LedgerClient, 'balances'>,
    options: PortfolioServiceOptions = {},
  ) {
    this.tickers = options.tickers;
    this.now = options.now ?? (() => new Date());
  }

  /** The caller's own total only: `userId` is the verified principal, never input. */
  async summary(userId: string): Promise<PortfolioSummary> {
    const holdings = holdingsFromBalances(await this.ledger.balances('user', userId));
    let tickers: TickerMap = new Map();
    if (needsPrices(holdings)) {
      if (!this.tickers) throw unavailable('no price source configured');
      try {
        tickers = await this.tickers.tickers();
      } catch (err) {
        throw err instanceof BankError ? err : unavailable('trade unreachable');
      }
    }
    return valuePortfolio({ holdings, tickers, nowMs: this.now().getTime() });
  }
}
