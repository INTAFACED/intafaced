import {
  LOCK_KIND_LIST,
  LOCK_KINDS,
  accountPurpose,
  formatAmount,
  parseAmount,
  type Amount,
  type Balance,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import {
  PRICES_UNAVAILABLE_COPY,
  holdingsFromBalances,
  needsPrices,
  valuePortfolio,
  type PortfolioSummary,
  type PriceBook,
  type TickerMap,
  type TickerQuote,
} from './valuation.js';

/**
 * PORTFOLIO SUMMARY — one server-computed "Est. total value" (UI-SPEC §1.2, U3).
 *
 * Balances come from the ledger: the user's own accounts (`'user'` owner) plus
 * every named Space they own (`'subaccount'` owner, one read per Space), so
 * money moved into a Space is still in the total. The main-account part is the
 * same read svc-trade's `/api/v1/account/balance` projects. Prices come from
 * svc-trade's public REST (`/api/v1/tickers` and `/api/v1/markets`), a READ of
 * another stream's public surface: no import, no shared table, nothing written
 * back. The rule itself lives in `valuation.ts`.
 *
 * If prices are needed and cannot be had, the call REFUSES `bank.prices_unavailable`.
 * A total that silently left out the coins it could not price would be a wrong
 * number with a plausible face. A user who holds only USDT, USDC or USD needs
 * no price, so that case is answered even while svc-trade is down.
 */

/** One lock kind of one asset: its total and the claims (order, escrow, stake, loan) that make it up. */
export interface LockBreakdown {
  readonly kind: string;
  readonly amount: string;
  readonly claims: Array<{ readonly purpose: string; readonly amount: string }>;
}

/** One asset, split exactly: total = available + the sum of every lock. */
export interface AssetBreakdown {
  readonly assetId: string;
  readonly total: string;
  readonly available: string;
  readonly locked: LockBreakdown[];
}

/** The port. One method: current prices. Throws on any failure. */
export interface TickerSource {
  prices(): Promise<PriceBook>;
}

export const DEFAULT_TICKER_TIMEOUT_MS = 3_000;
/** svc-trade's cap on `?limit=` (MAX_MARKETS). The limit is required, never defaulted by the server. */
export const TICKER_LIMIT = 500;

function unavailable(): BankError {
  return new BankError(PRICES_UNAVAILABLE_COPY, 'bank.prices_unavailable');
}

function amountOrNull(v: unknown): Amount | null {
  if (typeof v !== 'string') return null;
  try {
    return parseAmount(v);
  } catch {
    return null;
  }
}

/** svc-trade's public tickers and markets over HTTP, each with a hard timeout. */
export function httpTickerSource(options: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }): TickerSource {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TICKER_TIMEOUT_MS;
  const base = options.baseUrl.replace(/\/$/, '');

  async function getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}?limit=${TICKER_LIMIT}`, { signal: controller.signal });
      if (!res.ok) throw unavailable();
      return await res.json();
    } catch (err) {
      throw err instanceof BankError ? err : unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async prices() {
      const [tickersBody, marketsBody] = await Promise.all([getJson('/api/v1/tickers'), getJson('/api/v1/markets')]);

      if (tickersBody === null || typeof tickersBody !== 'object' || Array.isArray(tickersBody)) throw unavailable();
      if (!Array.isArray(marketsBody)) throw unavailable();

      const tickers = new Map<string, TickerQuote>();
      for (const [symbol, raw] of Object.entries(tickersBody as Record<string, unknown>)) {
        if (raw === null || typeof raw !== 'object') continue;
        const t = raw as Record<string, unknown>;
        tickers.set(symbol.toUpperCase(), {
          last: amountOrNull(t.last),
          open: amountOrNull(t.open),
          windowStart: typeof t.windowStart === 'number' && Number.isFinite(t.windowStart) ? t.windowStart : null,
        });
      }

      // Listed = a spot market that is not marked inactive. A halted market is
      // not owed a price; an active one missing from `tickers` means its book
      // could not be read right now.
      const listed = new Set<string>();
      for (const raw of marketsBody) {
        if (raw === null || typeof raw !== 'object') continue;
        const m = raw as Record<string, unknown>;
        if (typeof m.symbol !== 'string' || m.active === false) continue;
        if (m.type !== undefined && m.type !== 'spot') continue;
        listed.add(m.symbol.toUpperCase());
      }
      return { tickers, listed };
    },
  };
}

export interface PortfolioServiceOptions {
  /** Unset = no price counterparty: any user who holds a priced asset gets `bank.prices_unavailable`. */
  tickers?: TickerSource;
  now?: () => Date;
}

/** The slice of SpaceService the total needs: the user's named Spaces (live, plus archived ones that still hold value). */
export interface SpaceLister {
  namedSpaces(userId: string): Promise<SpaceRecord[]>;
}

export class PortfolioService {
  private readonly tickers: TickerSource | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly ledger: Pick<LedgerClient, 'balances'>,
    private readonly spaces: SpaceLister,
    options: PortfolioServiceOptions = {},
  ) {
    this.tickers = options.tickers;
    this.now = options.now ?? (() => new Date());
  }

  /** The caller's own total only: `userId` is the verified principal, never input. */
  async summary(userId: string): Promise<PortfolioSummary> {
    const rows = await this.everythingOwnedBy(userId);
    const holdings = holdingsFromBalances(rows);
    let prices: PriceBook = { tickers: new Map() as TickerMap, listed: new Set() };
    if (needsPrices(holdings)) {
      if (!this.tickers) throw unavailable();
      try {
        prices = await this.tickers.prices();
      } catch (err) {
        throw err instanceof BankError ? err : unavailable();
      }
    }
    return valuePortfolio({ holdings, tickers: prices.tickers, listed: prices.listed, nowMs: this.now().getTime() });
  }

  /**
   * Where each asset's balance sits: spendable, and each lock kind apart with the claim behind it. The same accounts as
   * `summary` (main plus named Spaces), read from the ledger and nothing else. The headline valuation still folds the locks
   * into one "used" figure; this read keeps them apart and never rounds or nets them. An asset whose accounts are all zero
   * is absent. A negative amount is shown as it is, so a broken book is seen and not hidden.
   */
  async balanceBreakdown(userId: string): Promise<{ assets: AssetBreakdown[] }> {
    const rows = await this.everythingOwnedBy(userId);
    const assets = [...new Set(rows.map((r) => r.account.assetId))].sort();
    const out: AssetBreakdown[] = [];
    for (const assetId of assets) {
      const mine = rows.filter((r) => r.account.assetId === assetId && r.amount !== 0n);
      if (mine.length === 0) continue;
      const sum = (list: readonly Balance[]) => list.reduce<Amount>((acc, r) => acc + r.amount, 0n);
      const locked: LockBreakdown[] = [];
      for (const kind of LOCK_KIND_LIST) {
        const ofKind = mine.filter((r) => r.account.kind === kind && LOCK_KINDS.has(r.account.kind));
        if (ofKind.length === 0) continue;
        const byPurpose = new Map<string, Amount>();
        for (const r of ofKind) {
          const purpose = accountPurpose(r.account);
          byPurpose.set(purpose, (byPurpose.get(purpose) ?? 0n) + r.amount);
        }
        const claims = [...byPurpose]
          .filter(([, amount]) => amount !== 0n)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([purpose, amount]) => ({ purpose, amount: formatAmount(amount) }));
        const amount = sum(ofKind);
        if (claims.length > 0) locked.push({ kind, amount: formatAmount(amount), claims });
      }
      const available = sum(mine.filter((r) => r.account.kind === 'available'));
      const total = available + locked.reduce<Amount>((acc, l) => acc + parseAmount(l.amount), 0n);
      out.push({ assetId, total: formatAmount(total), available: formatAmount(available), locked });
    }
    return { assets: out };
  }

  /**
   * Main account plus every named Space of this user. Space ids come from
   * svc-bank's own table filtered by `user_id`, so another user's Space can
   * never be read. Primary spaces are views over the user's own accounts and
   * are already in the first read.
   */
  private async everythingOwnedBy(userId: string): Promise<Balance[]> {
    const [own, spaces] = await Promise.all([this.ledger.balances('user', userId), this.spaces.namedSpaces(userId)]);
    const named = spaces.filter((s) => s.kind === 'named' && s.userId === userId);
    const perSpace = await Promise.all(named.map((s) => this.ledger.balances('subaccount', s.id)));
    return [...own, ...perSpace.flat()];
  }
}
