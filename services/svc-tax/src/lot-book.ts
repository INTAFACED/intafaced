import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { LOT_TRANSFER_SOURCES } from '@intafaced/contracts/tax-lot-book';
import { TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_BOOK_INCOMPLETE, TAX_LOT_BOOK_UNRECONCILED, TAX_TERM_RULE_UNSET } from './codes.js';
import {
  runLotEngine,
  type EngineMethod,
  type EngineMovement,
  type LotSource,
  type MethodSource,
  type SaleRules,
  type ValuedAt,
} from './lot-engine.js';
import type { OwnMove } from './own-moves.js';

/**
 * LOT BOOK. Profit and loss as an indicator, built only from the customer's own trade fills. Not a tax form and not tied to
 * a jurisdiction (that is the year pack). One fill is two legs of one ledger transaction: what the customer received (net of
 * the fee) and what left their order hold. A coin bought with a dollar coin has a real cost in dollars; a coin sold for a
 * dollar coin has real proceeds. A trade between two non-dollar coins has no dollar figure on either side (this platform
 * has no FX source and does not convert through a third market), so both sides stay unknown. Coins that arrived any other
 * way (a deposit, a reward, a transfer in) are a lot of their own, with the source named and the basis set by the owner's
 * deposit policy: the value at the time they arrived, or unknown until the customer enters one. Their value at that time
 * is shown either way, with the market and candle that priced it. A sale that reaches a lot with no basis is named, never
 * guessed.
 */

/** Counted as exactly 1 USD, the same set the bank's total-value rule uses. */
export const PAR_ASSETS: ReadonlySet<string> = new Set(['USDT', 'USDC', 'USD']);

/** The method when the caller names none. A product default for an indicator, not a tax rule; any call may pass another. */
export const DEFAULT_LOT_BOOK_METHOD: EngineMethod = 'FIFO';

export const INDICATOR_LABEL = 'indicator_not_tax_advice' as const;

export interface FillLeg {
  readonly assetId: string;
  readonly amount: Amount;
}

export interface Fill {
  readonly txId: string;
  readonly postedAt: Date;
  /** Credited to the customer's balance, net of fee. */
  readonly received: FillLeg;
  /** Left the customer's order hold. Null when the paying leg could not be read. */
  readonly paid: FillLeg | null;
  /** The fee taken from `received`, in its asset (0 when none was taken); null or absent when the ledger did not say. */
  readonly fee?: Amount | null;
}

/** Coins the customer sent out of the platform (a withdrawal), with their value when they left when a price was found. */
export interface Withdrawal {
  readonly txId: string;
  readonly postedAt: Date;
  readonly assetId: string;
  readonly amount: Amount;
  /** Value in dollars when it left; null when no price was found. */
  readonly valueUsd: Amount | null;
}

/** Lots from these sources, and withdrawals, are left out of every figure while the customer leaves transfers out. */
export const TRANSFER_SOURCES: ReadonlySet<LotSource> = new Set<LotSource>(LOT_TRANSFER_SOURCES);

/** A coin that reached the customer's balance other than by a fill, already valued by the caller. */
export interface Inflow {
  readonly txId: string;
  readonly postedAt: Date;
  readonly assetId: string;
  readonly amount: Amount;
  readonly reason: string;
  readonly source: Exclude<LotSource, 'trade'>;
  /** Basis under the owner's deposit policy; null when the policy leaves it to the customer, is unset, or no price exists. */
  readonly costUsd: Amount | null;
  readonly valuedAt: ValuedAt | null;
  /** The named space it arrived in; absent: the main account. */
  readonly spaceId?: string;
}

export interface BookAsset {
  readonly assetId: string;
  /** Quantity still open in main-account lots that the figures count. */
  readonly openQty: string;
  /** USD cost of that open quantity; null if any open lot has no known cost, or the book does not reconcile. */
  readonly openCostUsd: string | null;
  /** Everything the customer holds of the asset now (main account, all lock kinds, less withdrawals on their way out). */
  readonly held: string;
  /** Open main-account quantity left out of the figures (from transfers, while transfers are left out). */
  readonly uncountedQty: string;
}

export type BookFee =
  | { readonly status: 'known'; readonly assetId: string; readonly amount: string; readonly usd: string | null }
  | { readonly status: 'unknown' };

export interface BookValuedAt {
  readonly usd: string;
  readonly price: string;
  readonly market: string;
  readonly timeframe: string | null;
  readonly candleAt: string | null;
}

export interface BookLot {
  /** `lot:<acquireTxId>:<assetId>`: the same history gives the same id. */
  readonly id: string;
  readonly assetId: string;
  readonly acquiredAt: string;
  readonly source: LotSource;
  readonly qty: string;
  readonly remaining: string;
  /** Basis of the whole arrival, null when unknown. */
  readonly costUsd: string | null;
  /** Basis of what is left, null when unknown (or when the asset does not reconcile). */
  readonly remainingCostUsd: string | null;
  /** Value when it arrived and the price that gave it; null for a trade (its cost is what was paid) or no price. */
  readonly valuedAt: BookValuedAt | null;
  /** Whole days since it arrived, for a lot still open; null once it is all sold. */
  readonly daysHeld: number | null;
  /** Short or long term is a tax rule the owner has not published, so it is never filled in. */
  readonly termClass: null;
  /** Present only when this lot's cost is a price the customer entered. */
  readonly basisSource?: 'customer-entered';
  /** Present when the lot sits in one of the customer's named spaces; absent: the main account. */
  readonly spaceId?: string;
  /** Present when the customer-entered cost is a price stored under another lot (the one this lot was carried from). */
  readonly basisLotId?: string;
  /** Present when the lot was moved here from another of the customer's own accounts, with its date and basis. */
  readonly carriedFrom?: { readonly lotId: string; readonly txId: string; readonly movedAt: string };
  /** False when transfers are left out and the lot came from one. */
  readonly counted: boolean;
  /** The fee the buy took, on a lot bought on the exchange (not on a carried part). */
  readonly fee?: BookFee;
}

export interface BookMatch {
  readonly lotId: string;
  readonly qty: string;
  readonly costUsd: string | null;
  readonly proceedsUsd: string | null;
  readonly realizedUsd: string | null;
  /** Present only when this part's cost is a price the customer entered. */
  readonly basisSource?: 'customer-entered';
  readonly counted: boolean;
}

export type BookMethodSource = MethodSource;

export interface BookSale {
  /** `sale`: a trade. `moved_out`: a withdrawal, valued when it left. */
  readonly kind: 'sale' | 'moved_out';
  /** Which part the figures count; a part left out has no cost, proceeds or result in this sale's figures. */
  readonly counted: 'all' | 'part' | 'none';
  /** The fee taken from what this sale received; absent on a withdrawal. */
  readonly fee?: BookFee;
  /** The method this sale was matched by, and where it came from. */
  readonly method: EngineMethod;
  readonly methodSource: BookMethodSource;
  /** The lot the customer picked for this sale, when it was open and so drawn first. */
  readonly pickedLotId: string | null;
  readonly assetId: string;
  readonly txId: string;
  readonly disposedAt: string;
  readonly qty: string;
  /** Part of the sale that reached no lot (coins that arrived in a way the book cannot see). */
  readonly unmatchedQty: string;
  readonly proceedsUsd: string | null;
  readonly costUsd: string | null;
  readonly realizedUsd: string | null;
  /** The lots the sale drew on, in the order taken. */
  readonly matches: BookMatch[];
  /** Present when any part of this sale used a price the customer entered. */
  readonly basisSource?: 'customer-entered';
}

/** The customer's saved choices as the book shows them, or why none can be saved. */
export type BookChoices =
  | {
      readonly status: 'saved';
      readonly accountMethod: EngineMethod | null;
      readonly assetMethods: Array<{ assetId: string; method: EngineMethod }>;
      readonly days: Array<{ day: string; assetId: string | null; method: EngineMethod }>;
      readonly picks: Array<{ saleTxId: string; assetId: string; lotId: string }>;
      readonly includeTransfers: boolean | null;
    }
  | { readonly status: 'unwired'; readonly code: 'tax.basis_store_unwired' }
  | { readonly status: 'unavailable'; readonly code: 'tax.choices_unavailable' };

export const UNWIRED_CHOICES: BookChoices = { status: 'unwired', code: 'tax.basis_store_unwired' };

/** The customer's named spaces as svc-bank listed them, or why the book could not ask. */
export type BookSpaces =
  | {
      readonly status: 'read';
      readonly list: Array<{ spaceId: string; assetId: string; name: string; archived: boolean }>;
    }
  | { readonly status: 'unwired'; readonly code: 'tax.own_spaces_unwired' }
  | { readonly status: 'unavailable'; readonly code: 'tax.own_spaces_unavailable' };

export interface LotBook {
  /** The account's method: the previewed one, else the saved one, else the product default. */
  readonly method: EngineMethod;
  readonly preview: boolean;
  readonly choices: BookChoices;
  readonly indicator: typeof INDICATOR_LABEL;
  readonly assets: BookAsset[];
  readonly sales: BookSale[];
  readonly lots: BookLot[];
  /** Sum of every counted sale's result; null as soon as any is unknown. Null, not 0, when no sale counts. */
  readonly realizedUsd: string | null;
  /** Whether deposits, transfers in and withdrawals count in these figures. */
  readonly includeTransfers: boolean;
  /** Every trading fee in dollars at each fill's price; null when any is not known. */
  readonly feesUsd: string | null;
  /** The short-or-long-term rule is an owner value that is not published. */
  readonly termRule: { readonly status: 'unset'; readonly code: typeof TAX_TERM_RULE_UNSET };
  readonly residuals: string[];
  /** Customer-typed positions held apart from balances. Absent when there are none. */
  readonly manualPositions?: ManualPosition[];
  /** The named spaces whose lots the book follows. Absent when the caller did not ask about spaces. */
  readonly spaces?: BookSpaces;
}

export interface ManualPosition {
  readonly id: string;
  readonly assetId: string;
  readonly acquiredAt: string;
  readonly qty: string;
  readonly costUsd: string;
  readonly pricePerUnit: string;
  readonly sourceNote: string;
  readonly basisSource: 'customer-entered';
  readonly heldApart: true;
}

function movementsOf(fills: readonly Fill[], residuals: Set<string>): EngineMovement[] {
  const out: EngineMovement[] = [];
  for (const fill of fills) {
    const { received, paid } = fill;
    const receivedPar = PAR_ASSETS.has(received.assetId.toUpperCase());
    const paidPar = paid !== null && PAR_ASSETS.has(paid.assetId.toUpperCase());
    const acquire = (costUsd: Amount | null): EngineMovement => ({
      side: 'acquire',
      txId: fill.txId,
      postedAt: fill.postedAt,
      assetId: received.assetId,
      qty: received.amount,
      costUsd,
      source: 'trade',
      reason: 'trade.fill',
      valuedAt: null,
    });
    if (paid === null) {
      // The paying leg is unread: the receiving side is a real position change with an unknown other side.
      residuals.add(TAX_LOT_BOOK_INCOMPLETE);
      if (!receivedPar) out.push(acquire(null));
      continue;
    }
    if (receivedPar && paidPar) continue; // dollar coin for dollar coin: not a position in anything
    if (!receivedPar) out.push(acquire(paidPar ? paid.amount : null));
    if (!paidPar) {
      out.push({
        side: 'dispose',
        txId: fill.txId,
        postedAt: fill.postedAt,
        assetId: paid.assetId,
        qty: paid.amount,
        proceedsUsd: receivedPar ? received.amount : null,
      });
    }
  }
  return out;
}

const DAY_MS = 86_400_000;
const money = (v: Amount | null): string | null => (v === null ? null : formatAmount(v));
const isPar = (assetId: string) => PAR_ASSETS.has(assetId.toUpperCase());

/**
 * The fee a fill took, with its dollar value: a fee in a dollar coin is its own value; a fee in the coin bought is valued at
 * the fill's own price (what was paid over what the whole fill gave, fee included). Null `usd` when neither side is dollars.
 */
function feeOf(fill: Fill): { fee: BookFee; usd: Amount | null } {
  if (fill.fee === undefined || fill.fee === null) return { fee: { status: 'unknown' }, usd: null };
  const fee = fill.fee;
  const { received, paid } = fill;
  let usd: Amount | null = null;
  if (isPar(received.assetId)) usd = fee;
  else if (paid !== null && isPar(paid.assetId)) usd = fee === 0n ? 0n : (fee * paid.amount) / (received.amount + fee);
  return { fee: { status: 'known', assetId: received.assetId, amount: formatAmount(fee), usd: money(usd) }, usd };
}

export function buildLotBook(input: {
  fills: readonly Fill[];
  held: ReadonlyMap<string, Amount>;
  method: EngineMethod;
  /** How each sale is matched; absent: every sale by `method`. */
  rules?: SaleRules;
  /** One method asked for every sale, not the customer's saved choices. */
  preview?: boolean;
  choices?: BookChoices;
  /** The read stopped before the start of history. */
  truncated: boolean;
  /** Assets that reached the customer in a way the book could not turn into a lot: a sale may have used those coins first. */
  outsideInflows?: ReadonlySet<string>;
  /** Coins that reached the customer other than by a fill, each a lot of its own. */
  inflows?: readonly Inflow[];
  now?: Date;
  /** Dollars per unit for a lot that has no cost of its own. Keyed by lot id. Ignored when the lot already has a cost. */
  overridePricePerUnit?: ReadonlyMap<string, Amount>;
  /** Moves between the customer's own accounts: the lots go with the coins. */
  moves?: readonly OwnMove[];
  spaces?: BookSpaces;
  /** What each named space holds now, by coin, from its ledger history. Lots in a space are checked against it. */
  spaceHeld?: ReadonlyMap<string, ReadonlyMap<string, Amount>>;
  /** Coins sent out of the platform: each draws lots like a sale and is labelled moved out. */
  withdrawals?: readonly Withdrawal[];
  /** False: deposits, transfers in and withdrawals are left out of every figure (the lots stay listed). Absent: true. */
  includeTransfers?: boolean;
}): LotBook {
  const residuals = new Set<string>();
  if (input.truncated) residuals.add(TAX_LOT_BOOK_INCOMPLETE);
  const include = input.includeTransfers ?? true;
  const movements = movementsOf(input.fills, residuals);
  for (const out of input.withdrawals ?? []) {
    if (isPar(out.assetId)) continue; // a dollar coin is not a position
    movements.push({
      side: 'dispose',
      kind: 'moved_out',
      txId: out.txId,
      postedAt: out.postedAt,
      assetId: out.assetId,
      qty: out.amount,
      proceedsUsd: out.valueUsd,
    });
  }
  // Each fill's fee, on the sale it made and the lot it bought; the dollar total is added up once the sales are known.
  const saleFees = new Map<string, BookFee>();
  const lotFees = new Map<string, BookFee>();
  const feeParts: Array<{ saleKey: string | null; makesLot: boolean; usd: Amount | null }> = [];
  for (const fill of input.fills) {
    if (isPar(fill.received.assetId) && fill.paid !== null && isPar(fill.paid.assetId)) continue;
    const { fee, usd } = feeOf(fill);
    const makesLot = !isPar(fill.received.assetId);
    const saleKey = fill.paid !== null && !isPar(fill.paid.assetId) ? `${fill.txId}|${fill.paid.assetId}` : null;
    feeParts.push({ saleKey, makesLot, usd });
    if (makesLot) lotFees.set(`${fill.txId}|${fill.received.assetId}`, fee);
    if (saleKey !== null) saleFees.set(saleKey, fee);
  }
  for (const inflow of input.inflows ?? []) {
    if (PAR_ASSETS.has(inflow.assetId.toUpperCase())) continue; // a dollar coin is not a position
    movements.push({
      side: 'acquire',
      txId: inflow.txId,
      postedAt: inflow.postedAt,
      assetId: inflow.assetId,
      qty: inflow.amount,
      costUsd: inflow.costUsd,
      source: inflow.source,
      reason: inflow.reason,
      valuedAt: inflow.valuedAt,
      ...(inflow.spaceId === undefined ? {} : { space: inflow.spaceId }),
    });
  }
  for (const move of input.moves ?? []) {
    if (PAR_ASSETS.has(move.assetId.toUpperCase())) continue;
    movements.push({
      side: 'move',
      txId: move.txId,
      postedAt: move.postedAt,
      assetId: move.assetId,
      qty: move.amount,
      from: move.from,
      to: move.to,
    });
  }
  // Left out, the lots from transfers are a pool of their own, so their cost never reaches a trade's (KEPT APART).
  const run = runLotEngine(movements, input.rules ?? input.method, input.overridePricePerUnit, include ? undefined : TRANSFER_SOURCES);
  // Lots from transfers, and withdrawals, are left out while the customer leaves transfers out: they stay listed.
  const lotCounted = new Map(run.lots.map((lot) => [lot.id, include || !TRANSFER_SOURCES.has(lot.source)]));
  for (const r of run.residuals) {
    // A missing cost only matters where it reaches a figure: on a lot or a sale part that is left out, it is not named.
    if (r === TAX_COST_BASIS_UNAVAILABLE && !include) continue;
    residuals.add(r);
  }
  if (!include) {
    const openUnknown = run.lots.some((lot) => lot.remaining > 0n && lot.remainingCostUsd === null && lotCounted.get(lot.id));
    const partUnknown = run.sales.some(
      (sale) => sale.kind === 'sale' && sale.matches.some((m) => m.costUsd === null && lotCounted.get(m.lotId)),
    );
    if (openUnknown || partUnknown) residuals.add(TAX_COST_BASIS_UNAVAILABLE);
  }

  // Open quantity per asset. If more or less is open than the customer holds, coins arrived or left in a way the book
  // cannot see, and there is no way to say which lot is open: the cost of that asset is unknown, not a guess.
  // `qty` is every open lot (checked against what is held); `countedQty` and `cost` are the lots the figures count.
  const openByAsset = new Map<string, { qty: Amount; countedQty: Amount; cost: Amount | null }>();
  for (const lot of run.lots) {
    // `held` is the main account: lots in a space are listed under it and do not count here.
    if (lot.remaining === 0n || lot.space !== null) continue;
    const entry = openByAsset.get(lot.assetId) ?? { qty: 0n, countedQty: 0n, cost: 0n as Amount | null };
    entry.qty += lot.remaining;
    if (lotCounted.get(lot.id)) {
      entry.countedQty += lot.remaining;
      entry.cost = entry.cost === null || lot.remainingCostUsd === null ? null : entry.cost + lot.remainingCostUsd;
    }
    openByAsset.set(lot.assetId, entry);
  }
  const soldAssets = new Set(run.sales.map((sale) => sale.assetId));
  const assetIds = [...new Set([...openByAsset.keys(), ...input.held.keys(), ...(input.outsideInflows ?? [])])].sort();
  const assets: BookAsset[] = [];
  const outside = new Set<string>();
  for (const assetId of assetIds) {
    const open = openByAsset.get(assetId);
    const held = input.held.get(assetId) ?? 0n;
    const par = PAR_ASSETS.has(assetId.toUpperCase());
    const cameFromOutside = (input.outsideInflows?.has(assetId) ?? false) && !par;
    if (cameFromOutside && (soldAssets.has(assetId) || open !== undefined || held > 0n)) {
      residuals.add(TAX_LOT_BOOK_UNRECONCILED);
      outside.add(assetId);
    }
    if (open === undefined && held === 0n) continue;
    const reconciled = !cameFromOutside && ((open?.qty ?? 0n) === held || par);
    if (!reconciled) {
      residuals.add(TAX_LOT_BOOK_UNRECONCILED);
      outside.add(assetId);
    }
    if (open?.cost === null) residuals.add(TAX_COST_BASIS_UNAVAILABLE);
    assets.push({
      assetId,
      openQty: formatAmount(open?.countedQty ?? 0n),
      openCostUsd: open === undefined || !reconciled || input.truncated || open.cost === null ? null : formatAmount(open.cost),
      held: formatAmount(held),
      uncountedQty: formatAmount((open?.qty ?? 0n) - (open?.countedQty ?? 0n)),
    });
  }
  // A sale with no lot behind it at all leaves an asset unseen by the lots; it is unknown the same way.
  for (const assetId of soldAssets) if (input.outsideInflows?.has(assetId) && !PAR_ASSETS.has(assetId.toUpperCase())) outside.add(assetId);

  // Each space the same way: if its open lots do not add up to what it holds, coins left it in a way the book does not follow
  // (sent to someone else), so the cost of what is left there is unknown, not a guess.
  const spaceOutside = new Set<string>();
  for (const [spaceId, heldHere] of input.spaceHeld ?? []) {
    const open = new Map<string, Amount>();
    for (const lot of run.lots) if (lot.space === spaceId) open.set(lot.assetId, (open.get(lot.assetId) ?? 0n) + lot.remaining);
    for (const assetId of new Set([...open.keys(), ...heldHere.keys()])) {
      if (PAR_ASSETS.has(assetId.toUpperCase())) continue;
      if ((open.get(assetId) ?? 0n) !== (heldHere.get(assetId) ?? 0n)) {
        residuals.add(TAX_LOT_BOOK_UNRECONCILED);
        spaceOutside.add(`${spaceId}|${assetId}`);
      }
    }
  }

  const blank = (assetId: string) => input.truncated || outside.has(assetId);
  const blankLot = (lot: { assetId: string; space: string | null }) =>
    lot.space === null ? blank(lot.assetId) : input.truncated || spaceOutside.has(`${lot.space}|${lot.assetId}`);
  const sales: BookSale[] = run.sales.map((sale) => {
    const saleCounts = sale.kind === 'sale' || include;
    const matches = sale.matches.map((m) => {
      const costUsd = blank(sale.assetId) ? null : money(m.costUsd);
      return {
        lotId: m.lotId,
        qty: formatAmount(m.qty),
        costUsd,
        proceedsUsd: money(m.proceedsUsd),
        realizedUsd: blank(sale.assetId) ? null : money(m.realizedUsd),
        ...(m.customerEntered && costUsd !== null ? { basisSource: 'customer-entered' as const } : {}),
        counted: saleCounts && (lotCounted.get(m.lotId) ?? true),
      };
    });
    const countedParts = sale.matches.filter((m) => saleCounts && (lotCounted.get(m.lotId) ?? true));
    const counted: BookSale['counted'] = !saleCounts
      ? 'none'
      : countedParts.length === sale.matches.length
        ? 'all'
        : countedParts.length === 0 && sale.unmatchedQty === 0n
          ? 'none'
          : 'part';
    // The figures of the part that counts: all of it, some lots of it, or nothing. Quantity no lot covered stays unknown.
    const sumOf = (pick: (m: (typeof sale.matches)[number]) => Amount | null): Amount | null => {
      let total = 0n;
      for (const m of countedParts) {
        const v = pick(m);
        if (v === null) return null;
        total += v;
      }
      return total;
    };
    const partCost = sale.unmatchedQty > 0n ? null : sumOf((m) => m.costUsd);
    const partProceeds = sumOf((m) => m.proceedsUsd);
    const figures =
      counted === 'all'
        ? { proceedsUsd: money(sale.proceedsUsd), costUsd: money(sale.costUsd), realizedUsd: money(sale.realizedUsd) }
        : counted === 'none'
          ? { proceedsUsd: money(sale.proceedsUsd), costUsd: null, realizedUsd: null }
          : {
              proceedsUsd: money(partProceeds),
              costUsd: money(partCost),
              realizedUsd: partCost === null || partProceeds === null ? null : money(partProceeds - partCost),
            };
    const fee = sale.kind === 'sale' ? (saleFees.get(`${sale.txId}|${sale.assetId}`) ?? { status: 'unknown' as const }) : undefined;
    return {
      kind: sale.kind,
      counted,
      ...(fee === undefined ? {} : { fee }),
      method: sale.rule.method,
      methodSource: sale.rule.source,
      pickedLotId: sale.pickedLotId,
      assetId: sale.assetId,
      txId: sale.txId,
      disposedAt: sale.postedAt.toISOString(),
      qty: formatAmount(sale.qty),
      unmatchedQty: formatAmount(sale.unmatchedQty),
      proceedsUsd: figures.proceedsUsd,
      costUsd: blank(sale.assetId) ? null : figures.costUsd,
      realizedUsd: blank(sale.assetId) ? null : figures.realizedUsd,
      matches,
      ...(matches.some((m) => m.basisSource === 'customer-entered') ? { basisSource: 'customer-entered' as const } : {}),
    };
  });
  const now = (input.now ?? new Date()).getTime();
  const lots: BookLot[] = run.lots.map((lot) => ({
    id: lot.id,
    assetId: lot.assetId,
    acquiredAt: lot.acquiredAt.toISOString(),
    source: lot.source,
    qty: formatAmount(lot.qty),
    remaining: formatAmount(lot.remaining),
    costUsd: input.truncated ? null : money(lot.costUsd),
    remainingCostUsd: blankLot(lot) ? null : money(lot.remainingCostUsd),
    valuedAt:
      lot.valuedAt === null
        ? null
        : {
            usd: formatAmount(lot.valuedAt.usd),
            price: formatAmount(lot.valuedAt.price),
            market: lot.valuedAt.market,
            timeframe: lot.valuedAt.timeframe,
            candleAt: lot.valuedAt.candleAt === null ? null : lot.valuedAt.candleAt.toISOString(),
          },
    daysHeld: lot.remaining === 0n ? null : Math.max(0, Math.floor((now - lot.acquiredAt.getTime()) / DAY_MS)),
    termClass: null,
    ...(!input.truncated && lot.customerEntered && lot.costUsd !== null ? { basisSource: 'customer-entered' as const } : {}),
    ...(!input.truncated && lot.customerEntered && lot.costUsd !== null && lot.priceLotId !== undefined
      ? { basisLotId: lot.priceLotId }
      : {}),
    ...(lot.space === null ? {} : { spaceId: lot.space }),
    ...(lot.carriedFrom === undefined
      ? {}
      : { carriedFrom: { lotId: lot.carriedFrom.lotId, txId: lot.carriedFrom.txId, movedAt: lot.carriedFrom.movedAt.toISOString() } }),
    counted: lotCounted.get(lot.id) ?? true,
    ...(lot.source === 'trade' && lot.carriedFrom === undefined && lotFees.has(`${lot.acquireTxId}|${lot.assetId}`)
      ? { fee: lotFees.get(`${lot.acquireTxId}|${lot.assetId}`)! }
      : {}),
  }));

  // The fees inside the figures: a buy's is in its lot's cost (a bought lot always counts), a sale's in its result, so a
  // sale left out entirely (transfers left out, drawn only on their lots) leaves its fee out too.
  const saleByKey = new Map(sales.map((sale) => [`${sale.txId}|${sale.assetId}`, sale]));
  let feesUsd: Amount | null = 0n;
  for (const part of feeParts) {
    const sale = part.saleKey === null ? undefined : saleByKey.get(part.saleKey);
    if (!part.makesLot && sale?.counted === 'none') continue;
    if (part.usd === null) {
      feesUsd = null;
      break;
    }
    feesUsd += part.usd;
  }

  let realizedTotal: Amount | null = 0n;
  const countedSales = sales.filter((sale) => sale.counted !== 'none');
  for (const sale of countedSales) {
    if (sale.realizedUsd === null) {
      realizedTotal = null;
      break;
    }
    realizedTotal += parseAmount(sale.realizedUsd);
  }

  return {
    method: input.method,
    preview: input.preview ?? false,
    choices: input.choices ?? UNWIRED_CHOICES,
    indicator: INDICATOR_LABEL,
    assets,
    sales,
    lots,
    realizedUsd: countedSales.length === 0 ? null : realizedTotal === null ? null : formatAmount(realizedTotal),
    includeTransfers: include,
    feesUsd: money(feesUsd),
    termRule: { status: 'unset', code: TAX_TERM_RULE_UNSET },
    residuals: [...residuals].sort(),
    ...(input.spaces === undefined ? {} : { spaces: input.spaces }),
  };
}
