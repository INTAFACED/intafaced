import {
  LOCK_KIND_LIST,
  LOCK_KINDS,
  accountPurpose,
  DECIMALS,
  formatAmount,
  parseAmount,
  type Amount,
  type Balance,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  ActivityLookupBoundedError,
  ActivityUnavailableError,
  type LedgerHistoryPages,
  type LedgerPageEntry,
} from '../activity/activity-service.js';
import { allocate, type PortfolioAllocation } from './allocation.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import {
  PRICES_UNAVAILABLE_COPY,
  holdingsFromBalances,
  needsPrices,
  valuePortfolio,
  type Holding,
  PRICE_QUOTES,
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

/** One account the balances can be read for: the main account, or one named Space. */
export interface BreakdownAccount {
  readonly accountId: string;
  readonly walletType: 'main' | 'space';
  readonly name: string | null;
}

/** One asset, split exactly: total = available + the sum of every lock. */
export interface AssetBreakdown {
  readonly assetId: string;
  readonly total: string;
  readonly available: string;
  readonly locked: LockBreakdown[];
}

/** The portfolio value in BTC. Both fields are null, with the reason, when no BTC price is published. */
export interface BtcValuation {
  readonly total: string | null;
  readonly priceUsd: string | null;
  readonly reason: 'no_price_published' | 'nothing_priced' | null;
}

const BTC_DP = 8n;
const BTC_SCALE_UP = 10n ** (BigInt(DECIMALS) - BTC_DP);

/**
 * The USD value of everything counted, divided by the last BTC price (BTC/USDT, else BTC/USDC), rounded half-up to 8
 * decimals. What was left unpriced stays out of it, exactly as it stays out of the USD total.
 */
function btcValuation(summary: PortfolioSummary, prices: PriceBook): BtcValuation {
  const unpublished: BtcValuation = { total: null, priceUsd: null, reason: 'no_price_published' };
  // Nothing held is worth exactly nothing in any unit, with no price needed.
  if (summary.priced.length === 0 && summary.unpriced.length === 0) return { total: '0', priceUsd: null, reason: null };
  // Something is held and none of it could be priced: the USD total is blank, so the BTC total is blank, not zero.
  if (summary.priced.length === 0) return { total: null, priceUsd: null, reason: 'nothing_priced' };
  let price: Amount | null = null;
  for (const quote of PRICE_QUOTES) {
    const last = prices.tickers.get(`BTC/${quote}`)?.last ?? null;
    if (last !== null && last > 0n) {
      price = last;
      break;
    }
  }
  if (price === null) return unpublished;
  const value = summary.priced.reduce<Amount>((acc, row) => acc + parseAmount(row.valueUsd), 0n);
  // One rounding, half-up, straight to 8 decimals: value / price in units of 10^-8.
  const units = (value * 10n ** BTC_DP * 2n + price) / (price * 2n);
  const rounded = units * BTC_SCALE_UP;
  return { total: formatAmount(rounded), priceUsd: formatAmount(price), reason: null };
}

/**
 * The unit a total is shown in. USD and BTC are priced from the same book; any other currency has no rate source (an owner
 * value that stays blank) and refuses by name instead of quietly showing USD.
 */
function displayUnit(displayCurrency: string | undefined, valueIn: 'usd' | 'btc' | undefined): 'usd' | 'btc' | undefined {
  if (displayCurrency === undefined) return valueIn;
  const code = displayCurrency.toUpperCase();
  if (code === 'USD') return 'usd';
  if (code === 'BTC') return 'btc';
  throw new BankError(`No exchange rate is set for ${code}`, 'bank.fx_rate_unset');
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
  /** svc-ledger `historyPage`, read only. Unset = `balanceEntries` refuses `ActivityUnavailableError`. */
  pages?: LedgerHistoryPages;
  now?: () => Date;
}

/** Entries read per ledger page, and the most pages read for one balance before it is called too long to prove. */
const ENTRY_PAGE = 200;
const ENTRY_MAX_PAGES = 50;
export const BALANCE_ENTRIES_DEFAULT_LIMIT = 50;
export const BALANCE_ENTRIES_MAX_LIMIT = 200;

/** One ledger entry behind a balance, newest first. `accountId` is `main` or the id of the Space it posted to. */
export interface BalanceEntry {
  readonly entryId: string | null;
  readonly txId: string;
  readonly accountId: string;
  readonly reason: string;
  readonly direction: 'debit' | 'credit';
  readonly amount: string;
  readonly postedAt: string;
}

export interface BalanceEntriesPage {
  readonly assetId: string;
  readonly entries: BalanceEntry[];
  readonly nextCursor: string | null;
  /** The signed sum of every entry read equals the live spendable balance, or the call refused. */
  readonly sumCheck: { readonly ok: true; readonly entriesSum: string; readonly balance: string; readonly entryCount: number };
}

/** The slice of SpaceService the total needs: the user's named Spaces (live, plus archived ones that still hold value). */
export interface SpaceLister {
  namedSpaces(userId: string): Promise<SpaceRecord[]>;
}

export class PortfolioService {
  private readonly tickers: TickerSource | undefined;
  private readonly pages: LedgerHistoryPages | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly ledger: Pick<LedgerClient, 'balances'>,
    private readonly spaces: SpaceLister,
    options: PortfolioServiceOptions = {},
  ) {
    this.tickers = options.tickers;
    this.pages = options.pages;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The caller's own total only: `userId` is the verified principal, never input. `assetId` narrows the total to one
   * asset; `valueIn: 'btc'` adds the same value in BTC, read from a published BTC price. No published price is a
   * blank, never a guess.
   */
  async summary(
    userId: string,
    options: { assetId?: string; valueIn?: 'usd' | 'btc'; displayCurrency?: string; scope?: string } = {},
  ): Promise<PortfolioSummary & { btc?: BtcValuation }> {
    const valueIn = displayUnit(options.displayCurrency, options.valueIn);
    const { summary, prices } = await this.valued(userId, options.assetId, valueIn === 'btc', options.scope);
    return valueIn === 'btc' ? { ...summary, btc: btcValuation(summary, prices) } : summary;
  }

  /** The priced holdings grouped by class and by where they sit (PF-balances-02); same prices and refusals as `summary`. */
  async allocation(userId: string): Promise<PortfolioAllocation> {
    const { summary, holdings } = await this.valued(userId);
    return allocate(summary, holdings);
  }

  private async valued(
    userId: string,
    assetId?: string,
    wantBtc = false,
    scope?: string,
  ): Promise<{ summary: PortfolioSummary; holdings: Holding[]; prices: PriceBook }> {
    const rows = await this.rowsInScope(userId, scope);
    const only = assetId?.toUpperCase();
    const holdings = holdingsFromBalances(rows).filter((h) => only === undefined || h.assetId.toUpperCase() === only);
    let prices: PriceBook = { tickers: new Map() as TickerMap, listed: new Set() };
    if (needsPrices(holdings) || (wantBtc && holdings.length > 0)) {
      if (!this.tickers) throw unavailable();
      try {
        prices = await this.tickers.prices();
      } catch (err) {
        throw err instanceof BankError ? err : unavailable();
      }
    }
    return {
      summary: valuePortfolio({ holdings, tickers: prices.tickers, listed: prices.listed, nowMs: this.now().getTime() }),
      holdings,
      prices,
    };
  }

  /**
   * Where each asset's balance sits: spendable, and each lock kind apart with the claim behind it. The same accounts as
   * `summary` (main plus named Spaces), read from the ledger and nothing else. The headline valuation still folds the locks
   * into one "used" figure; this read keeps them apart and never rounds or nets them. An asset whose accounts are all zero
   * is absent. A negative amount is shown as it is, so a broken book is seen and not hidden.
   */
  async balanceBreakdown(
    userId: string,
    scope: 'all' | 'main' = 'all',
    filter: { accountId?: string; assetId?: string } = {},
  ): Promise<{ assets: AssetBreakdown[] }> {
    // `main` is the person's own accounts only, the same figure as the exchange balance; `all` adds every named Space.
    // `accountId` picks one of the listed accounts; one that is not the caller's is refused, never read.
    let rows: Balance[];
    const wanted = filter.accountId?.toLowerCase();
    if (filter.accountId === 'main') rows = await this.ledger.balances('user', userId);
    else if (wanted !== undefined) {
      const space = (await this.namedOf(userId)).find((s) => s.id.toLowerCase() === wanted);
      if (!space) throw new BankError('That account is not yours', 'bank.space_not_found');
      rows = await this.ledger.balances('subaccount', space.id);
    } else rows = scope === 'main' ? await this.ledger.balances('user', userId) : await this.everythingOwnedBy(userId);
    const only = filter.assetId?.toUpperCase();
    const assets = [...new Set(rows.map((r) => r.account.assetId))].filter((a) => only === undefined || a.toUpperCase() === only).sort();
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
   * Every ledger entry behind one asset's spendable balance, newest first (PF-balances-01, portfolio-balances-002).
   * The whole history of the asset is read (bounded), the signed sum of it is compared with the live balance, and the
   * page is cut from that. A sum that differs refuses `portfolio.entries_do_not_sum` and names the gap: a list that does not
   * add up is never shown, and a history that fails or is too long to read gives no partial check. Locks have no entries
   * of their own here: they are balances of other account kinds, shown by `balanceBreakdown`. Read only; self only.
   */
  async balanceEntries(
    userId: string,
    input: { assetId: string; accountId?: string; cursor?: string; limit?: number },
  ): Promise<BalanceEntriesPage> {
    if (!this.pages) throw new ActivityUnavailableError();
    const assetId = input.assetId.toUpperCase();
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? BALANCE_ENTRIES_DEFAULT_LIMIT), 1), BALANCE_ENTRIES_MAX_LIMIT);
    if (input.cursor !== undefined && !/^\d{1,9}$/.test(input.cursor)) {
      throw new BankError('That page marker is not valid', 'bank.activity_range');
    }
    const skip = input.cursor === undefined ? 0 : Number(input.cursor);

    const named = await this.namedOf(userId);
    const owners: Array<{ accountId: string; ownerType: 'user' | 'subaccount'; ownerId: string }> = [];
    if (input.accountId === undefined || input.accountId === 'main') owners.push({ accountId: 'main', ownerType: 'user', ownerId: userId });
    if (input.accountId === undefined) {
      for (const s of named) owners.push({ accountId: s.id, ownerType: 'subaccount', ownerId: s.id });
    } else if (input.accountId !== 'main') {
      const space = named.find((s) => s.id.toLowerCase() === input.accountId!.toLowerCase());
      if (!space) throw new BankError('That account is not yours', 'bank.space_not_found');
      owners.push({ accountId: space.id, ownerType: 'subaccount', ownerId: space.id });
    }

    const all: Array<LedgerPageEntry & { accountId: string }> = [];
    let balance = 0n;
    for (const owner of owners) {
      const live = await this.ledger.balances(owner.ownerType, owner.ownerId);
      for (const r of live) {
        if (r.account.kind === 'available' && r.account.assetId.toUpperCase() === assetId) balance += r.amount;
      }
      let cursor: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page >= ENTRY_MAX_PAGES) throw new ActivityLookupBoundedError();
        let got: Awaited<ReturnType<LedgerHistoryPages['page']>>;
        try {
          got = await this.pages.page({
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            kind: 'available',
            assetId,
            limit: ENTRY_PAGE,
            ...(cursor === undefined ? {} : { cursor }),
          });
        } catch {
          throw new ActivityUnavailableError();
        }
        for (const e of got.entries) {
          if (e.assetId.toUpperCase() === assetId) all.push({ ...e, accountId: owner.accountId });
        }
        if (got.nextCursor === null) break;
        cursor = got.nextCursor;
      }
    }

    const entriesSum = all.reduce<Amount>((acc, e) => acc + (e.direction === 'debit' ? 1n : -1n) * parseAmount(e.amount), 0n);
    if (entriesSum !== balance) {
      const gap = entriesSum - balance;
      throw new BankError(
        `The entries add up to ${formatAmount(entriesSum)} ${assetId} but the balance is ${formatAmount(balance)}, a gap of ${formatAmount(gap)}`,
        'portfolio.entries_do_not_sum',
      );
    }

    // Newest first: by time, then by book position when the ledger sends one, then by transaction id so the order is fixed.
    all.sort((a, b) => {
      const t = b.postedAt.getTime() - a.postedAt.getTime();
      if (t !== 0) return t;
      const ea = a.entryId === undefined ? -1n : BigInt(a.entryId);
      const eb = b.entryId === undefined ? -1n : BigInt(b.entryId);
      if (ea !== eb) return ea < eb ? 1 : -1;
      return a.txId < b.txId ? 1 : a.txId > b.txId ? -1 : 0;
    });
    const slice = all.slice(skip, skip + limit);
    const shown = skip + slice.length;
    return {
      assetId,
      entries: slice.map((e) => ({
        entryId: e.entryId ?? null,
        txId: e.txId,
        accountId: e.accountId,
        reason: e.reason,
        direction: e.direction,
        amount: e.amount,
        postedAt: e.postedAt.toISOString(),
      })),
      nextCursor: shown < all.length ? String(shown) : null,
      sumCheck: { ok: true, entriesSum: formatAmount(entriesSum), balance: formatAmount(balance), entryCount: all.length },
    };
  }

  /**
   * `combined` (the default) is main plus every named space; `main` is the person's own accounts only; anything else must be
   * the id of one of the caller's own named spaces. A space that is not the caller's is refused, never read, so the sum of
   * the spaces plus main is always the combined total.
   */
  private async rowsInScope(userId: string, scope?: string): Promise<Balance[]> {
    if (scope === undefined || scope === 'combined') return this.everythingOwnedBy(userId);
    if (scope === 'main') return this.ledger.balances('user', userId);
    const wanted = scope.toLowerCase();
    const space = (await this.namedOf(userId)).find((s) => s.id.toLowerCase() === wanted);
    if (!space) throw new BankError('That account is not yours', 'bank.space_not_found');
    return this.ledger.balances('subaccount', space.id);
  }

  private async namedOf(userId: string): Promise<SpaceRecord[]> {
    return (await this.spaces.namedSpaces(userId)).filter((s) => s.kind === 'named' && s.userId === userId);
  }

  /** The accounts a balance read can be narrowed to: the main account, then each named Space. Names only, no amounts. */
  async accounts(userId: string): Promise<{ accounts: BreakdownAccount[] }> {
    return {
      accounts: [
        { accountId: 'main', walletType: 'main', name: null },
        ...(await this.namedOf(userId)).map((s) => ({ accountId: s.id, walletType: 'space' as const, name: s.name })),
      ],
    };
  }

  /**
   * Main account plus every named Space of this user. Space ids come from
   * svc-bank's own table filtered by `user_id`, so another user's Space can
   * never be read. Primary spaces are views over the user's own accounts and
   * are already in the first read.
   */
  private async everythingOwnedBy(userId: string): Promise<Balance[]> {
    const spaces = await this.spaces.namedSpaces(userId);
    return this.ownedWith(
      userId,
      spaces.filter((s) => s.kind === 'named' && s.userId === userId),
    );
  }

  private async ownedWith(userId: string, named: readonly SpaceRecord[]): Promise<Balance[]> {
    const own = await this.ledger.balances('user', userId);
    const perSpace = await Promise.all(named.map((s) => this.ledger.balances('subaccount', s.id)));
    return [...own, ...perSpace.flat()];
  }
}
