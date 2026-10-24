import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import { listMissingBasis, parseBasisSet, type BasisSetInput, type MissingBasisItem } from './basis-override.js';
import { type ActiveBasis, type BasisRow, type BasisStore } from './basis-store.js';
import {
  PORTFOLIO_BASIS_OVERRIDE_NOT_ALLOWED,
  TAX_BASIS_LOT_UNKNOWN,
  TAX_BASIS_STORE_UNWIRED,
  TAX_CHOICES_UNAVAILABLE,
  TAX_CLOSED_LOTS_UNINDEXED,
  TAX_COST_BASIS_UNAVAILABLE,
  TAX_CUSTOMER_BASIS_EXPORT_UNSET,
  TAX_DATA_LAKE_UNAVAILABLE,
  TAX_DATA_LAKE_UNPROBED,
  TAX_DEPOSIT_BASIS_POLICY_UNSET,
  TAX_EXPORT_INCOMPLETE,
  TAX_HISTORY_YEARS_UNSET,
  TAX_INDEXER_UNAVAILABLE,
  TAX_INDEXER_UNPROBED,
  TAX_LEDGER_UNWIRED,
  TAX_LOT_METHOD_REQUIRED,
  TAX_LOT_PICK_INVALID,
  TAX_OWN_SPACES_UNAVAILABLE,
  TAX_OWN_SPACES_UNWIRED,
  TAX_PRICE_AT_TIME_UNAVAILABLE,
  TaxError,
} from './codes.js';
import { parseJurisdictionMap, refuseExportCompleteness, requireMappedRegion, type JurisdictionMap } from './jurisdiction-map.js';
import type { AccountLine, HistoryRange, InflowLine, SubAccountActivityLine, TaxLedgerReads } from './ledger-reads.js';
import type { PriceAt, PriceAtTime } from './prices.js';
import {
  buildLotBook,
  DEFAULT_LOT_BOOK_METHOD,
  PAR_ASSETS,
  type BookChoices,
  type BookSpaces,
  type Inflow,
  type LotBook,
  type ManualPosition,
  type Withdrawal,
} from './lot-book.js';
import type { BankOwnSpacesPort } from '@intafaced/contracts';
import { pairOwnMoves, type OwnMove, type SpaceInflow } from './own-moves.js';
import { outsideWithdrawals, WITHDRAWAL_HOLD_PREFIX } from './withdrawals.js';
import { NO_CHOICES, saleRules, type ChoiceStore, type CostBasisChoices } from './choices.js';
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
  /** Customer-entered basis. Absent: writes refuse `tax.basis_store_unwired` and the book ignores overrides. */
  readonly basis?: BasisStore;
  /** The customer's saved cost-basis choices. Absent: saves refuse `tax.basis_store_unwired` and the product default applies. */
  readonly choices?: ChoiceStore;
  /** Which named spaces are the customer's (svc-bank). Absent: the book follows the main account only, `tax.own_spaces_unwired`. */
  readonly spaces?: BankOwnSpacesPort;
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
  private readonly basis: BasisStore | undefined;
  private readonly choices: ChoiceStore | undefined;
  private readonly spaces: BankOwnSpacesPort | undefined;

  constructor(deps: TaxServiceDeps) {
    this.map = parseJurisdictionMap(deps.mapRaw);
    this.reads = deps.reads;
    this.lake = deps.lake;
    this.indexer = deps.indexer;
    this.historyYears = deps.historyYears;
    this.now = deps.now ?? (() => new Date());
    this.depositBasis = deps.depositBasis;
    this.prices = deps.prices;
    this.basis = deps.basis;
    this.choices = deps.choices;
    this.spaces = deps.spaces;
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
    if (this.choices) {
      try {
        saved = await this.choices.read(input.userId);
      } catch {
        unreadable = true;
      }
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
    const shared = {
      method,
      rules: saleRules(saved, DEFAULT_LOT_BOOK_METHOD, preview),
      preview: preview !== null,
      choices,
      // A preview changes the method only; whether transfers count stays the customer's choice.
      includeTransfers: saved.includeTransfers ?? true,
    };
    const readFills = this.reads.tradeFills;
    if (!readFills) throw new TaxError(TAX_LEDGER_UNWIRED, 'the ledger fill reader is not attached — tax does not invent a book');
    const [balances, filled, active, spaces] = await Promise.all([
      this.reads.balances('user', userId),
      readFills.call(this.reads, userId),
      this.activeBasis(userId),
      this.ownSpaces(userId),
    ]);
    const held = new Map<string, Amount>();
    // Coins held for a withdrawal are on their way out: the book counts them gone from the moment they were held.
    const followsWithdrawals = filled.inflows !== undefined;
    for (const row of balances) {
      if (followsWithdrawals && row.account.kind === 'hold' && (row.account.purpose ?? '').startsWith(WITHDRAWAL_HOLD_PREFIX)) continue;
      if (row.amount > 0n) held.set(row.account.assetId, (held.get(row.account.assetId) ?? 0n) + row.amount);
    }
    const overridePricePerUnit = pricesOf(active);
    if (filled.inflows === undefined) {
      return this.withManual(
        buildLotBook({
          ...shared,
          fills: filled.fills,
          held,
          truncated: filled.truncated,
          outsideInflows: filled.outsideInflows,
          ...(overridePricePerUnit ? { overridePricePerUnit } : {}),
        }),
        active,
      );
    }
    const extra = new Set<string>();
    const own = await this.ownMoves(spaces, filled.inflows, filled.outflows ?? [], extra);
    const inflows = await this.valueInflows([...own.mainInflows, ...own.spaceInflows], extra);
    // Left out, a withdrawal reaches no figure, so a missing price for it is not a reason any figure is unknown.
    const withdrawals = await this.valueWithdrawals(
      outsideWithdrawals(filled.withdrawalHolds ?? []),
      shared.includeTransfers ? extra : new Set<string>(),
    );
    const book = buildLotBook({
      ...shared,
      fills: filled.fills,
      held,
      truncated: filled.truncated || own.truncated,
      inflows,
      moves: own.moves,
      withdrawals,
      spaces: own.spaces,
      ...(own.spaceHeld ? { spaceHeld: own.spaceHeld } : {}),
      now: this.now(),
      ...(overridePricePerUnit ? { overridePricePerUnit } : {}),
    });
    return this.withManual({ ...book, residuals: [...new Set([...book.residuals, ...extra])].sort() }, active);
  }

  /** The caller's named spaces from svc-bank. No port: unwired; no answer: unavailable, and the book says so. */
  private async ownSpaces(userId: string): Promise<BookSpaces> {
    if (!this.spaces) return { status: 'unwired', code: TAX_OWN_SPACES_UNWIRED };
    const got = await this.spaces.list({ userId });
    if (got.state !== 'read') return { status: 'unavailable', code: TAX_OWN_SPACES_UNAVAILABLE };
    return {
      status: 'read',
      list: got.spaces.map((s) => ({ spaceId: s.spaceId, assetId: s.assetId, name: s.name, archived: s.archived })),
    };
  }

  /**
   * Reads the caller's spaces' ledger history and pairs lines inside one transaction into moves between their own accounts
   * (own-moves.ts). A space history that cannot be read leaves the spaces out of this answer, named, rather than failing it.
   */
  private async ownMoves(
    spaces: BookSpaces,
    mainInflows: readonly InflowLine[],
    mainOutflows: readonly AccountLine[],
    residuals: Set<string>,
  ): Promise<{
    spaces: BookSpaces;
    moves: OwnMove[];
    mainInflows: InflowLine[];
    spaceInflows: SpaceInflow[];
    truncated: boolean;
    spaceHeld?: Map<string, Map<string, Amount>>;
  }> {
    const none = { moves: [], mainInflows: [...mainInflows], spaceInflows: [], truncated: false };
    if (spaces.status === 'unavailable') residuals.add(TAX_OWN_SPACES_UNAVAILABLE);
    if (spaces.status !== 'read' || spaces.list.length === 0) return { spaces, ...none };
    const readHistory = this.reads.spaceHistory;
    if (!readHistory) {
      residuals.add(TAX_OWN_SPACES_UNAVAILABLE);
      return { spaces: { status: 'unavailable', code: TAX_OWN_SPACES_UNAVAILABLE }, ...none };
    }
    let history;
    try {
      history = await readHistory.call(
        this.reads,
        spaces.list.map((s) => s.spaceId),
      );
    } catch {
      residuals.add(TAX_OWN_SPACES_UNAVAILABLE);
      return { spaces: { status: 'unavailable', code: TAX_OWN_SPACES_UNAVAILABLE }, ...none };
    }
    // What each space holds now, from its own lines: the book checks the space's lots against it.
    const spaceHeld = new Map<string, Map<string, Amount>>();
    for (const line of history.lines) {
      const held = spaceHeld.get(line.spaceId) ?? new Map<string, Amount>();
      held.set(line.assetId, (held.get(line.assetId) ?? 0n) + (line.direction === 'debit' ? line.amount : -line.amount));
      spaceHeld.set(line.spaceId, held);
    }
    for (const space of spaces.list) if (!spaceHeld.has(space.spaceId)) spaceHeld.set(space.spaceId, new Map());
    return {
      spaces,
      ...pairOwnMoves({ mainInflows, mainOutflows, spaceLines: history.lines }),
      truncated: history.truncated,
      spaceHeld,
    };
  }

  private bookChoices(saved: CostBasisChoices): BookChoices {
    if (!this.choices) return { status: 'unwired', code: TAX_BASIS_STORE_UNWIRED };
    return {
      status: 'saved',
      accountMethod: saved.accountMethod,
      assetMethods: [...saved.assetMethods].sort(([a], [b]) => a.localeCompare(b)).map(([assetId, m]) => ({ assetId, method: m })),
      days: saved.days.map((d) => ({ day: d.day, assetId: d.assetId, method: d.method })),
      picks: saved.picks.map((p) => ({ saleTxId: p.saleTxId, assetId: p.assetId, lotId: p.lotId })),
      includeTransfers: saved.includeTransfers,
    };
  }

  /** Whether the caller's deposits, transfers in and withdrawals count in their figures; null clears it. Settings only. */
  async setIncludeTransfers(input: { userId: string; include: boolean | null }): Promise<void> {
    await this.choiceStoreOrRefuse().setIncludeTransfers(input.userId, input.include);
  }

  /** The caller's method for the whole account (`assetId` null) or one coin; null clears it. Settings only. */
  async setLotMethod(input: { userId: string; assetId: string | null; method: string | null }): Promise<void> {
    const method = input.method === null ? null : requireBookMethod(input.method);
    await this.choiceStoreOrRefuse().setMethod(input.userId, input.assetId, method);
  }

  /** The caller's method for one UTC day, for one coin or every coin; null clears it. Settings only. */
  async setDayMethod(input: { userId: string; day: string; assetId: string | null; method: string | null }): Promise<void> {
    const method = input.method === null ? null : requireBookMethod(input.method);
    await this.choiceStoreOrRefuse().setDayMethod(input.userId, input.day, input.assetId, method);
  }

  /**
   * The lot one of the caller's sales draws on first; null clears it. Worked out with the pick in place: the sale must be in
   * the caller's own book, and the lot of that coin and still open at the sale (arrived by then, not used up by an earlier
   * sale), so the sale really draws on it. Anything else is refused, not stored.
   */
  async pickSaleLot(input: { userId: string; saleTxId: string; assetId: string; lotId: string | null }): Promise<void> {
    const store = this.choiceStoreOrRefuse();
    if (input.lotId !== null) {
      const saved = await store.read(input.userId);
      const picks = [
        ...saved.picks.filter((p) => !(p.saleTxId === input.saleTxId && p.assetId === input.assetId)),
        { saleTxId: input.saleTxId, assetId: input.assetId, lotId: input.lotId },
      ];
      const book = await this.bookWith(input.userId, null, { ...saved, picks }, this.bookChoices(saved));
      const sale = book.sales.find((s) => s.txId === input.saleTxId && s.assetId === input.assetId);
      if (!sale || sale.pickedLotId !== input.lotId) {
        throw new TaxError(TAX_LOT_PICK_INVALID, 'that lot is not one this sale could draw on: same coin, arrived by then, not used up');
      }
      // Under AVERAGE every coin costs the pool's average, so a picked lot would change no figure: refused, not stored.
      if (sale.method === 'AVERAGE') throw new TaxError(TAX_LOT_PICK_INVALID, 'a sale matched at the average cost draws on no one lot');
    }
    await store.setPick(input.userId, input.saleTxId, input.assetId, input.lotId);
  }

  private choiceStoreOrRefuse(): ChoiceStore {
    if (!this.choices) throw new TaxError(TAX_BASIS_STORE_UNWIRED, 'DATABASE_URL is unset — a cost-basis choice is not stored');
    return this.choices;
  }

  /** Lots and disposals whose basis is still null. The effect column is "unknown share", never a computed gain. */
  async missingBasis(input: { userId: string; method?: string }): Promise<{ items: MissingBasisItem[] }> {
    const book = await this.lotBook(input);
    return { items: listMissingBasis(book) };
  }

  /**
   * Gives a lot with no cost a customer-entered basis, or records a manual position that is not a balance.
   * The key is `basisoverride:<userId>:<lotId>:<version>`. The same payload twice is one version.
   */
  async basisOverrideSet(input: BasisSetInput): Promise<BasisResult> {
    const store = this.storeOrRefuse();
    const write = parseBasisSet(input);
    if (write.kind === 'override') await this.assertUnknownLot(input.userId, write.lotId);
    const row = await store.save(write);
    return resultOf(row);
  }

  /** Drops a customer basis. The ledger figure is unchanged, and the unknown it replaced is what the book shows again. */
  async basisOverrideRemove(input: { userId: string; lotId: string }): Promise<BasisResult> {
    const store = this.storeOrRefuse();
    const lotId = input.lotId.trim();
    if (lotId.length === 0) throw new TaxError(TAX_BASIS_LOT_UNKNOWN, 'a basis write needs a lot id');
    return resultOf(await store.clear(input.userId, lotId));
  }

  private storeOrRefuse(): BasisStore {
    if (!this.basis) {
      throw new TaxError(TAX_BASIS_STORE_UNWIRED, 'DATABASE_URL is unset — a customer basis is not stored');
    }
    return this.basis;
  }

  private activeBasis(userId: string): Promise<readonly ActiveBasis[]> {
    return this.basis ? this.basis.listActive(userId) : Promise.resolve([]);
  }

  private withManual(book: LotBook, active: readonly ActiveBasis[]): LotBook {
    const manualPositions = manualOf(active);
    return manualPositions.length === 0 ? book : { ...book, manualPositions };
  }

  private async assertUnknownLot(userId: string, lotId: string): Promise<void> {
    const book = await this.lotBook({ userId });
    const lot = book.lots.find((row) => row.id === lotId);
    if (!lot) throw new TaxError(TAX_BASIS_LOT_UNKNOWN, 'that lot is not in this account');
    if (lot.costUsd !== null && lot.basisSource !== 'customer-entered') {
      throw new TaxError(PORTFOLIO_BASIS_OVERRIDE_NOT_ALLOWED, 'a lot that already has a cost from our own records is not overwritten');
    }
  }

  /** Each arrival becomes a lot: its source, its value when it arrived, and the basis the owner's policy gives it. */
  private async valueInflows(lines: ReadonlyArray<InflowLine & { spaceId?: string }>, residuals: Set<string>): Promise<Inflow[]> {
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
          ...(line.spaceId === undefined ? {} : { spaceId: line.spaceId }),
        };
      }),
    );
  }

  /** Each withdrawal, valued when it left: quantity times the coin's price at that moment, or null when none was found. */
  private async valueWithdrawals(lines: readonly AccountLine[], residuals: Set<string>): Promise<Withdrawal[]> {
    const coins = lines.filter((line) => !PAR_ASSETS.has(line.assetId.toUpperCase()));
    return Promise.all(
      coins.map(async (line): Promise<Withdrawal> => {
        // A failed market data read is the same as no price: the value stays unknown and is named.
        const price = this.prices ? await this.prices.priceAt(line.assetId, line.postedAt).catch(() => null) : null;
        if (price === null) residuals.add(TAX_PRICE_AT_TIME_UNAVAILABLE);
        return {
          txId: line.txId,
          postedAt: line.postedAt,
          assetId: line.assetId,
          amount: line.amount,
          valueUsd: price === null ? null : mul(line.amount, price.price),
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
    if ((await this.activeBasis(input.userId)).length > 0) residuals.add(TAX_CUSTOMER_BASIS_EXPORT_UNSET);

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

export interface BasisResult {
  readonly businessKey: string;
  readonly version: number;
  readonly lotId: string;
  readonly kind: BasisRow['kind'];
  readonly basisSource: 'customer-entered' | null;
}

function pricesOf(active: readonly ActiveBasis[]): Map<string, Amount> | undefined {
  const map = new Map<string, Amount>();
  for (const row of active) {
    if (row.kind === 'override') map.set(row.lotId, parseAmount(row.pricePerUnit));
  }
  return map.size === 0 ? undefined : map;
}

function manualOf(active: readonly ActiveBasis[]): ManualPosition[] {
  const out: ManualPosition[] = [];
  for (const row of active) {
    if (row.kind !== 'manual') continue;
    out.push({
      id: row.lotId,
      assetId: row.assetId,
      acquiredAt: row.acquiredAt,
      qty: row.qty,
      pricePerUnit: row.pricePerUnit,
      costUsd: formatAmount(mul(parseAmount(row.pricePerUnit), parseAmount(row.qty))),
      sourceNote: row.sourceNote,
      basisSource: 'customer-entered',
      heldApart: true,
    });
  }
  return out;
}

function resultOf(row: BasisRow): BasisResult {
  return {
    businessKey: row.businessKey,
    version: row.version,
    lotId: row.lotId,
    kind: row.kind,
    basisSource: row.kind === 'tombstone' ? null : 'customer-entered',
  };
}

export function lakeStatusFromUrl(url: string | undefined): LakeStatus {
  if (!url || url.trim().length === 0) return { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE };
  return { status: 'configured', code: TAX_DATA_LAKE_UNPROBED };
}

export function indexerStatusFromUrl(url: string | undefined): LakeStatus {
  if (!url || url.trim().length === 0) return { status: 'absent', code: TAX_INDEXER_UNAVAILABLE };
  return { status: 'configured', code: TAX_INDEXER_UNPROBED };
}
