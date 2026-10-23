import { formatAmount, mul, type Amount } from '@intafaced/ledger-client';
import {
  TAX_CLOSED_LOTS_UNINDEXED,
  TAX_COST_BASIS_UNAVAILABLE,
  TAX_DATA_LAKE_UNAVAILABLE,
  TAX_DATA_LAKE_UNPROBED,
  TAX_EXPORT_INCOMPLETE,
  TAX_HISTORY_YEARS_UNSET,
  TAX_INDEXER_UNAVAILABLE,
  TAX_INDEXER_UNPROBED,
  TAX_LEDGER_UNWIRED,
  TAX_LOT_METHOD_REQUIRED,
  TAX_DEPOSIT_BASIS_POLICY_UNSET,
  TAX_PRICE_AT_TIME_UNAVAILABLE,
  TAX_CHOICES_UNAVAILABLE,
  TAX_DATABASE_URL_UNSET,
  TAX_LOT_PICK_INVALID,
  TaxError,
} from './codes.js';
import { parseJurisdictionMap, refuseExportCompleteness, requireMappedRegion, type JurisdictionMap } from './jurisdiction-map.js';
import type { HistoryRange, InflowLine, SubAccountActivityLine, TaxLedgerReads } from './ledger-reads.js';
import type { PriceAt, PriceAtTime } from './prices.js';
import { buildLotBook, DEFAULT_LOT_BOOK_METHOD, PAR_ASSETS, type BookChoices, type Inflow, type LotBook } from './lot-book.js';
import { NO_CHOICES, saleRules, unwiredChoices, type ChoiceStore, type CostBasisChoices } from './choices.js';
import { isLotMethod, runLots, type LotMethod, type LotMovement } from './lots.js';
import { isEngineMethod, type EngineMethod, type ValuedAt } from './lot-engine.js';

/** The lot book also offers AVERAGE; the year pack takes FIFO, LIFO or HIFO only. */
function requireBookMethod(raw: string): EngineMethod {
  if (!isEngineMethod(raw)) throw new TaxError(TAX_LOT_METHOD_REQUIRED, 'Caller must select FIFO, LIFO, HIFO or AVERAGE');
  return raw;
}

/**
 * Q-tax leftover — an env URL is not a live lake/indexer.
 *
 * Blank → `absent`. Set → `configured` (unprobed). Never `ok`: this process
 * does not query TSDB or the indexer, so a URL is config, not evidence.
 */
export type LakeStatus =
  | { readonly status: 'absent'; readonly code: typeof TAX_DATA_LAKE_UNAVAILABLE | typeof TAX_INDEXER_UNAVAILABLE }
  | { readonly status: 'configured'; readonly code: typeof TAX_DATA_LAKE_UNPROBED | typeof TAX_INDEXER_UNPROBED };

export interface TaxYearLine {
  readonly kind: 'fill' | 'convert';
  readonly postedAt: string;
  readonly assetId: string;
  readonly qty: string;
  readonly fee: string | null;
  readonly makerRebate: string | null;
  readonly costBasis: string | null;
  readonly proceeds: string | null;
  readonly realized: string | null;
}

export interface TaxSubAccountYear {
  readonly subAccountId: string;
  readonly lines: TaxYearLine[];
  readonly realized: string | null;
  readonly residuals: string[];
}

export interface TaxExportPreview {
  readonly empty: boolean;
  readonly complete: false;
  readonly lotMethod: LotMethod;
  readonly jurisdiction: string;
  readonly lotCount: number;
  readonly realized: string | null;
  readonly unrealized: string | null;
  readonly lake: LakeStatus;
  readonly indexer: LakeStatus;
  readonly residuals: string[];
  /** `unwired` names a missing sub-account reader. It is not an empty trading year. */
  readonly subAccountBooks: 'unwired' | 'read';
  readonly subAccounts: TaxSubAccountYear[];
}

export interface TaxExportPack extends TaxExportPreview {
  readonly filename: string;
  readonly mime: 'application/json';
  readonly bodyBase64: string;
}

export interface TaxServiceDeps {
  readonly mapRaw: string;
  readonly reads: TaxLedgerReads;
  readonly lake: LakeStatus;
  readonly indexer: LakeStatus;
  /** Owner-published window. Blank / omit → `tax.history_years_unset` (never invent 10). */
  readonly historyYears?: number;
  readonly now?: () => Date;
  /**
   * Owner policy for the cost of a coin that arrived by deposit, reward or transfer in: `market` (its value when it
   * arrived) or `customer` (unknown until the customer enters one). Unset: unknown, named `tax.deposit_basis_policy_unset`.
   */
  readonly depositBasis?: DepositBasisPolicy;
  /** Price of a coin at a past moment. Absent: arrivals are not valued, named `tax.price_at_time_unavailable`. */
  readonly prices?: PriceAtTime;
  /** The customer's saved cost-basis choices. Absent: nothing can be saved and the product default applies. */
  readonly choices?: ChoiceStore;
}

export const DEPOSIT_BASIS_POLICIES = ['market', 'customer'] as const;
export type DepositBasisPolicy = (typeof DEPOSIT_BASIS_POLICIES)[number];

/** Where a coin that was not bought came from, by the ledger reason that brought it. */
export function inflowSource(reason: string): Inflow['source'] {
  if (reason.startsWith('deposit.')) return 'deposit';
  if (reason === 'bank.earn.interest' || reason.includes('reward')) return 'reward';
  if (reason.startsWith('bank.transfer') || reason === 'identity.sub_account.transfer' || reason.startsWith('pay.')) return 'transfer_in';
  return 'other_in';
}

function moneyOrNull(value: Amount | null): string | null {
  return value === null ? null : formatAmount(value);
}

function inPublishedWindow(at: Date, range: HistoryRange): boolean {
  const t = at.getTime();
  return Number.isFinite(t) && t >= range.from.getTime() && t <= range.to.getTime();
}

function lineRealized(costBasis: Amount | null, proceeds: Amount | null): Amount | null {
  if (costBasis === null || proceeds === null) return null;
  return proceeds - costBasis;
}

function toYearLine(line: SubAccountActivityLine): TaxYearLine {
  return {
    kind: line.kind,
    postedAt: line.postedAt.toISOString(),
    assetId: line.assetId,
    qty: formatAmount(line.qty),
    fee: moneyOrNull(line.fee),
    makerRebate: moneyOrNull(line.makerRebate),
    costBasis: moneyOrNull(line.costBasis),
    proceeds: moneyOrNull(line.proceeds),
    realized: moneyOrNull(lineRealized(line.costBasis, line.proceeds)),
  };
}

/**
 * One sub-account's year. Basis is read from that line only.
 * A null on another account cannot land here, and a null here is not rewritten as 0.
 * Fee and maker rebate stay in their columns; they are not added into realised gain.
 */
export function subAccountYear(subAccountId: string, activity: readonly SubAccountActivityLine[], range: HistoryRange): TaxSubAccountYear {
  const kept = activity
    .filter((line) => inPublishedWindow(line.postedAt, range))
    .slice()
    .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.id.localeCompare(b.id));
  const missingBasis = kept.some((line) => line.costBasis === null);
  let sum = 0n;
  let anyGain = false;
  if (!missingBasis) {
    for (const line of kept) {
      const realized = lineRealized(line.costBasis, line.proceeds);
      if (realized === null) continue;
      sum += realized;
      anyGain = true;
    }
  }
  return {
    subAccountId,
    lines: kept.map(toYearLine),
    realized: missingBasis || !anyGain ? null : formatAmount(sum),
    residuals: missingBasis ? [TAX_COST_BASIS_UNAVAILABLE] : [],
  };
}

/**
 * Owner-published export history window. Blank / non-integer / out of 1..100
 * refuses. Never invent 10 years. Never clamp.
 */
export function requirePublishedHistoryYears(years: number | undefined): number {
  if (years === undefined || typeof years !== 'number' || !Number.isInteger(years) || years < 1 || years > 100) {
    throw new TaxError(
      TAX_HISTORY_YEARS_UNSET,
      'TAX_HISTORY_YEARS is unset — owner must publish the export history window (never invent 10 years)',
    );
  }
  return years;
}

export class TaxService {
  private readonly map: JurisdictionMap;
  private readonly reads: TaxLedgerReads;
  private readonly lake: LakeStatus;
  private readonly indexer: LakeStatus;
  private readonly historyYears: number | undefined;
  private readonly now: () => Date;
  private readonly depositBasis: DepositBasisPolicy | undefined;
  private readonly prices: PriceAtTime | undefined;
  private readonly choices: ChoiceStore;

  constructor(deps: TaxServiceDeps) {
    this.map = parseJurisdictionMap(deps.mapRaw);
    this.reads = deps.reads;
    this.lake = deps.lake;
    this.indexer = deps.indexer;
    this.historyYears = deps.historyYears;
    this.now = deps.now ?? (() => new Date());
    this.depositBasis = deps.depositBasis;
    this.prices = deps.prices;
    this.choices = deps.choices ?? unwiredChoices;
  }

  async exportPreview(input: { userId: string; region: string; lotMethod: string; complete?: boolean }): Promise<TaxExportPreview> {
    const built = await this.build(input);
    return built.preview;
  }

  async exportPack(input: { userId: string; region: string; lotMethod: string; complete?: boolean }): Promise<TaxExportPack> {
    return this.build(input).then((built) => built.pack);
  }

  /**
   * Profit and loss as an indicator, from the caller's own ledger (lot-book.ts). Not tied to a jurisdiction map and not a
   * tax pack. Without a method it applies the customer's saved choices (choices.ts), else the product default FIFO; with
   * one it previews that method for every sale. An unknown name is refused, not guessed.
   */
  async lotBook(input: { userId: string; method?: string }): Promise<LotBook> {
    const preview = input.method === undefined ? null : requireBookMethod(input.method);
    // The indicator needs no settings to be worked out: if the saved choices cannot be read, it answers with the default
    // and says so (`choices.status: 'unavailable'`), rather than failing every customer's page.
    let saved: CostBasisChoices = NO_CHOICES;
    let unreadable = false;
    try {
      saved = await this.choices.read(input.userId);
    } catch {
      unreadable = true;
    }
    return this.bookWith(
      input.userId,
      preview,
      saved,
      unreadable ? { status: 'unavailable', code: TAX_CHOICES_UNAVAILABLE } : this.bookChoices(saved),
    );
  }

  private async bookWith(userId: string, preview: EngineMethod | null, saved: CostBasisChoices, choices: BookChoices): Promise<LotBook> {
    const method = preview ?? saved.accountMethod ?? DEFAULT_LOT_BOOK_METHOD;
    const shared = { method, rules: saleRules(saved, DEFAULT_LOT_BOOK_METHOD, preview), preview: preview !== null, choices };
    const readFills = this.reads.tradeFills;
    if (!readFills) throw new TaxError(TAX_LEDGER_UNWIRED, 'the ledger fill reader is not attached — tax does not invent a book');
    const [balances, filled] = await Promise.all([this.reads.balances('user', userId), readFills.call(this.reads, userId)]);
    const held = new Map<string, Amount>();
    for (const row of balances) {
      if (row.amount > 0n) held.set(row.account.assetId, (held.get(row.account.assetId) ?? 0n) + row.amount);
    }
    if (filled.inflows === undefined) {
      return buildLotBook({ ...shared, fills: filled.fills, held, truncated: filled.truncated, outsideInflows: filled.outsideInflows });
    }
    const extra = new Set<string>();
    const inflows = await this.valueInflows(filled.inflows, extra);
    const book = buildLotBook({ ...shared, fills: filled.fills, held, truncated: filled.truncated, inflows, now: this.now() });
    return { ...book, residuals: [...new Set([...book.residuals, ...extra])].sort() };
  }

  private bookChoices(saved: CostBasisChoices): BookChoices {
    if (this.choices.status === 'unwired') return { status: 'unwired', code: this.choices.code ?? TAX_DATABASE_URL_UNSET };
    return {
      status: 'saved',
      accountMethod: saved.accountMethod,
      assetMethods: [...saved.assetMethods].sort(([a], [b]) => a.localeCompare(b)).map(([assetId, m]) => ({ assetId, method: m })),
      days: saved.days.map((d) => ({ day: d.day, assetId: d.assetId, method: d.method })),
      picks: saved.picks.map((p) => ({ saleTxId: p.saleTxId, assetId: p.assetId, lotId: p.lotId })),
    };
  }

  /** The caller's method for the whole account (`assetId` null) or one coin; null clears it. Settings only. */
  async setLotMethod(input: { userId: string; assetId: string | null; method: string | null }): Promise<void> {
    await this.choices.setMethod(input.userId, input.assetId, input.method === null ? null : requireBookMethod(input.method));
  }

  /** The caller's method for one UTC day, for one coin or every coin; null clears it. Settings only. */
  async setDayMethod(input: { userId: string; day: string; assetId: string | null; method: string | null }): Promise<void> {
    await this.choices.setDayMethod(input.userId, input.day, input.assetId, input.method === null ? null : requireBookMethod(input.method));
  }

  /**
   * The lot one of the caller's sales draws on first; null clears it. The sale and the lot must both be in the caller's own
   * book, for the same coin, and the lot must have arrived by the time of the sale. Anything else is refused, not stored.
   */
  async pickSaleLot(input: { userId: string; saleTxId: string; assetId: string; lotId: string | null }): Promise<void> {
    if (input.lotId !== null) {
      // Worked out with the pick in place: the sale must exist, and the lot must be of that coin and still open at the sale
      // (arrived by then and not used up by an earlier sale), so the sale really draws on it. Anything else is not stored.
      const saved = await this.choices.read(input.userId);
      const picks = [
        ...saved.picks.filter((p) => !(p.saleTxId === input.saleTxId && p.assetId === input.assetId)),
        { saleTxId: input.saleTxId, assetId: input.assetId, lotId: input.lotId },
      ];
      const book = await this.bookWith(input.userId, null, { ...saved, picks }, this.bookChoices(saved));
      const sale = book.sales.find((s) => s.txId === input.saleTxId && s.assetId === input.assetId);
      if (!sale || sale.pickedLotId !== input.lotId) {
        throw new TaxError(TAX_LOT_PICK_INVALID, 'that lot is not one this sale could draw on: same coin, arrived by then, not used up');
      }
    }
    await this.choices.setPick(input.userId, input.saleTxId, input.assetId, input.lotId);
  }

  /** Each arrival becomes a lot: its source, its value when it arrived, and the basis the owner's policy gives it. */
  private async valueInflows(lines: readonly InflowLine[], residuals: Set<string>): Promise<Inflow[]> {
    const cache = new Map<string, Promise<PriceAt | null>>();
    const priceAt = (assetId: string, at: Date): Promise<PriceAt | null> => {
      const prices = this.prices;
      if (!prices) return Promise.resolve(null);
      const key = `${assetId}|${Math.floor(at.getTime() / 60_000)}`;
      let hit = cache.get(key);
      if (!hit) {
        // A failed market data read is the same as no price: the value stays unknown and is named, the book still answers.
        hit = prices.priceAt(assetId, at).catch(() => null);
        cache.set(key, hit);
      }
      return hit;
    };
    if (this.depositBasis === undefined && lines.some((line) => !PAR_ASSETS.has(line.assetId.toUpperCase()))) {
      residuals.add(TAX_DEPOSIT_BASIS_POLICY_UNSET);
    }
    // Prices are read side by side; the cache keeps one read per coin and minute.
    const coins = lines.filter((line) => !PAR_ASSETS.has(line.assetId.toUpperCase()));
    return Promise.all(
      coins.map(async (line): Promise<Inflow> => {
        const price = await priceAt(line.assetId, line.postedAt);
        if (price === null) residuals.add(TAX_PRICE_AT_TIME_UNAVAILABLE);
        const valuedAt: ValuedAt | null =
          price === null
            ? null
            : {
                usd: mul(line.amount, price.price),
                market: price.market,
                timeframe: price.timeframe,
                candleAt: price.candleAt,
                price: price.price,
              };
        return {
          txId: line.txId,
          postedAt: line.postedAt,
          assetId: line.assetId,
          amount: line.amount,
          reason: line.reason,
          source: inflowSource(line.reason),
          costUsd: this.depositBasis === 'market' && valuedAt !== null ? valuedAt.usd : null,
          valuedAt,
        };
      }),
    );
  }

  private requireMethod(raw: string): LotMethod {
    if (!isLotMethod(raw)) {
      throw new TaxError(TAX_LOT_METHOD_REQUIRED, 'Caller must select FIFO, LIFO, or HIFO — no silent default');
    }
    return raw;
  }

  private async build(input: { userId: string; region: string; lotMethod: string; complete?: boolean }): Promise<{
    preview: TaxExportPreview;
    pack: TaxExportPack;
  }> {
    refuseExportCompleteness(input.complete);
    const lotMethod = this.requireMethod(input.lotMethod);
    const jurisdiction = requireMappedRegion(this.map, input.region);
    const historyYears = requirePublishedHistoryYears(this.historyYears);
    const now = this.now();
    const range = {
      from: new Date(Date.UTC(now.getUTCFullYear() - historyYears, 0, 1)),
      to: now,
    };

    const balances = await this.reads.balances('user', input.userId);
    const available = balances.filter((b) => b.account.kind === 'available');
    const residuals = new Set<string>();
    residuals.add(TAX_CLOSED_LOTS_UNINDEXED);
    residuals.add(TAX_EXPORT_INCOMPLETE);

    const movements: LotMovement[] = [];
    for (const row of available) {
      const entries = await this.reads.history(row.account, range);
      for (const e of entries) {
        movements.push({
          assetId: row.account.assetId,
          side: e.direction === 'debit' ? 'acquire' : 'dispose',
          qty: e.amount,
          costBasis: null,
          proceeds: null,
          postedAt: e.postedAt,
          txId: e.txId,
          reason: e.reason,
        });
      }
    }

    if (movements.length > 0) residuals.add(TAX_COST_BASIS_UNAVAILABLE);

    const lots = runLots(movements, lotMethod);
    for (const r of lots.residuals) residuals.add(r);

    const year = await this.subAccountBooks(input.userId, range);
    for (const account of year.accounts) {
      for (const code of account.residuals) residuals.add(code);
    }

    const empty =
      lots.lotsClosed.length === 0 && lots.lotsOpen.length === 0 && year.accounts.every((account) => account.lines.length === 0);
    const preview: TaxExportPreview = {
      empty,
      complete: false,
      lotMethod,
      jurisdiction,
      lotCount: lots.lotsClosed.length + lots.lotsOpen.length,
      realized: empty ? null : lots.realized,
      unrealized: empty ? null : lots.unrealized,
      lake: this.lake,
      indexer: this.indexer,
      residuals: [...residuals].sort(),
      subAccountBooks: year.books,
      subAccounts: year.accounts,
    };

    const body = {
      schema: 'intafaced.tax.export.v1',
      empty: preview.empty,
      complete: false as const,
      lotMethod,
      jurisdiction,
      lotsClosed: lots.lotsClosed,
      lotsOpen: lots.lotsOpen,
      realized: preview.realized,
      unrealized: preview.unrealized,
      lake: this.lake,
      indexer: this.indexer,
      residuals: preview.residuals,
      subAccountBooks: preview.subAccountBooks,
      subAccounts: preview.subAccounts,
      note: empty
        ? 'empty book — not a $0 PnL'
        : 'cost basis not on the ledger history wire; missing basis is unknown, not a FIFO/LIFO/HIFO invent or 0',
      currentAvailable: available.map((b) => ({
        assetId: b.account.assetId,
        amount: formatAmount(b.amount),
      })),
    };

    const json = `${JSON.stringify(body, null, 2)}\n`;
    const filename = `intafaced-tax-${jurisdiction}-${lotMethod}-${now.toISOString().slice(0, 10)}.json`;
    const pack: TaxExportPack = {
      ...preview,
      filename,
      mime: 'application/json',
      bodyBase64: Buffer.from(json, 'utf8').toString('base64'),
    };
    return { preview, pack };
  }

  private async subAccountBooks(
    userId: string,
    range: HistoryRange,
  ): Promise<{ books: 'unwired' | 'read'; accounts: TaxSubAccountYear[] }> {
    const ids = this.reads.subAccountIds;
    const activity = this.reads.subAccountActivity;
    if (!ids || !activity) return { books: 'unwired', accounts: [] };
    const subAccountIds = await ids(userId);
    const accounts: TaxSubAccountYear[] = [];
    for (const subAccountId of subAccountIds) {
      const lines = await activity(subAccountId, range);
      accounts.push(subAccountYear(subAccountId, lines, range));
    }
    return { books: 'read', accounts };
  }
}

export function lakeStatusFromUrl(url: string | undefined): LakeStatus {
  if (!url || url.trim().length === 0) return { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE };
  return { status: 'configured', code: TAX_DATA_LAKE_UNPROBED };
}

export function indexerStatusFromUrl(url: string | undefined): LakeStatus {
  if (!url || url.trim().length === 0) return { status: 'absent', code: TAX_INDEXER_UNAVAILABLE };
  return { status: 'configured', code: TAX_INDEXER_UNPROBED };
}
