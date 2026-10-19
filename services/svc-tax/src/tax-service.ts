import { formatAmount, type Amount } from '@intafaced/ledger-client';
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
  TaxError,
} from './codes.js';
import { parseJurisdictionMap, refuseExportCompleteness, requireMappedRegion, type JurisdictionMap } from './jurisdiction-map.js';
import type { HistoryRange, SubAccountActivityLine, TaxLedgerReads } from './ledger-reads.js';
import { buildLotBook, DEFAULT_LOT_BOOK_METHOD, type LotBook } from './lot-book.js';
import { isLotMethod, runLots, type LotMethod, type LotMovement } from './lots.js';

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

  constructor(deps: TaxServiceDeps) {
    this.map = parseJurisdictionMap(deps.mapRaw);
    this.reads = deps.reads;
    this.lake = deps.lake;
    this.indexer = deps.indexer;
    this.historyYears = deps.historyYears;
    this.now = deps.now ?? (() => new Date());
  }

  async exportPreview(input: { userId: string; region: string; lotMethod: string; complete?: boolean }): Promise<TaxExportPreview> {
    const built = await this.build(input);
    return built.preview;
  }

  async exportPack(input: { userId: string; region: string; lotMethod: string; complete?: boolean }): Promise<TaxExportPack> {
    return this.build(input).then((built) => built.pack);
  }

  /**
   * Profit and loss as an indicator, from the caller's own trade fills (lot-book.ts). Not tied to a jurisdiction map and not a
   * tax pack. The method defaults to FIFO (a product default, changeable per call); an unknown name is refused, not guessed.
   */
  async lotBook(input: { userId: string; method?: string }): Promise<LotBook> {
    const method = input.method === undefined ? DEFAULT_LOT_BOOK_METHOD : this.requireMethod(input.method);
    const readFills = this.reads.tradeFills;
    if (!readFills) throw new TaxError(TAX_LEDGER_UNWIRED, 'the ledger fill reader is not attached — tax does not invent a book');
    const [balances, filled] = await Promise.all([this.reads.balances('user', input.userId), readFills.call(this.reads, input.userId)]);
    const held = new Map<string, Amount>();
    for (const row of balances) {
      if (row.amount > 0n) held.set(row.account.assetId, (held.get(row.account.assetId) ?? 0n) + row.amount);
    }
    return buildLotBook({ fills: filled.fills, held, method, truncated: filled.truncated });
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
