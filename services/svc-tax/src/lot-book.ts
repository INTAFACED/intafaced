import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_BOOK_INCOMPLETE, TAX_LOT_BOOK_UNRECONCILED, TAX_TERM_RULE_UNSET } from './codes.js';
import { runLotEngine, type EngineMethod, type EngineMovement, type LotSource, type SaleRules, type ValuedAt } from './lot-engine.js';

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
}

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
}

export interface BookAsset {
  readonly assetId: string;
  /** Quantity still open in lots. */
  readonly openQty: string;
  /** USD cost of that open quantity; null if any open lot has no known cost, or the book does not reconcile. */
  readonly openCostUsd: string | null;
  /** Everything the customer holds of the asset now (main account, all lock kinds). */
  readonly held: string;
}

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
}

export interface BookMatch {
  readonly lotId: string;
  readonly qty: string;
  readonly costUsd: string | null;
  readonly proceedsUsd: string | null;
  readonly realizedUsd: string | null;
}

export type BookMethodSource = 'preview' | 'day' | 'asset' | 'account' | 'default';

export interface BookSale {
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
}

/** The customer's saved choices as the book shows them, or why none can be saved. */
export type BookChoices =
  | {
      readonly status: 'saved';
      readonly accountMethod: EngineMethod | null;
      readonly assetMethods: Array<{ assetId: string; method: EngineMethod }>;
      readonly days: Array<{ day: string; assetId: string | null; method: EngineMethod }>;
      readonly picks: Array<{ saleTxId: string; assetId: string; lotId: string }>;
    }
  | { readonly status: 'unwired'; readonly code: 'tax.database_url_unset' | 'tax.database_pool_max_unset' };

export const UNWIRED_CHOICES: BookChoices = { status: 'unwired', code: 'tax.database_url_unset' };

export interface LotBook {
  /** The account's method: the previewed one, else the saved one, else the product default. */
  readonly method: EngineMethod;
  readonly preview: boolean;
  readonly choices: BookChoices;
  readonly indicator: typeof INDICATOR_LABEL;
  readonly assets: BookAsset[];
  readonly sales: BookSale[];
  readonly lots: BookLot[];
  /** Sum of every sale's result; null as soon as any sale's result is unknown. Null, not 0, when there is no sale. */
  readonly realizedUsd: string | null;
  /** The short-or-long-term rule is an owner value that is not published. */
  readonly termRule: { readonly status: 'unset'; readonly code: typeof TAX_TERM_RULE_UNSET };
  readonly residuals: string[];
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
const METHOD_SOURCES: readonly BookMethodSource[] = ['preview', 'day', 'asset', 'account', 'default'];
/** One method passed for the whole book (no saved choices) reads as the default. */
const methodSourceOf = (source: string): BookMethodSource =>
  (METHOD_SOURCES as readonly string[]).includes(source) ? (source as BookMethodSource) : 'default';
const money = (v: Amount | null): string | null => (v === null ? null : formatAmount(v));

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
}): LotBook {
  const residuals = new Set<string>();
  if (input.truncated) residuals.add(TAX_LOT_BOOK_INCOMPLETE);
  const movements = movementsOf(input.fills, residuals);
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
    });
  }
  const run = runLotEngine(movements, input.rules ?? input.method);
  for (const r of run.residuals) residuals.add(r);

  // Open quantity per asset. If more or less is open than the customer holds, coins arrived or left in a way the book
  // cannot see, and there is no way to say which lot is open: the cost of that asset is unknown, not a guess.
  const openByAsset = new Map<string, { qty: Amount; cost: Amount | null }>();
  for (const lot of run.lots) {
    if (lot.remaining === 0n) continue;
    const entry = openByAsset.get(lot.assetId) ?? { qty: 0n, cost: 0n as Amount | null };
    entry.qty += lot.remaining;
    entry.cost = entry.cost === null || lot.remainingCostUsd === null ? null : entry.cost + lot.remainingCostUsd;
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
      openQty: formatAmount(open?.qty ?? 0n),
      openCostUsd: open === undefined || !reconciled || input.truncated || open.cost === null ? null : formatAmount(open.cost),
      held: formatAmount(held),
    });
  }
  // A sale with no lot behind it at all leaves an asset unseen by the lots; it is unknown the same way.
  for (const assetId of soldAssets) if (input.outsideInflows?.has(assetId) && !PAR_ASSETS.has(assetId.toUpperCase())) outside.add(assetId);

  const blank = (assetId: string) => input.truncated || outside.has(assetId);
  const sales: BookSale[] = run.sales.map((sale) => ({
    method: sale.rule.method,
    methodSource: methodSourceOf(sale.rule.source),
    pickedLotId: sale.pickedLotId,
    assetId: sale.assetId,
    txId: sale.txId,
    disposedAt: sale.postedAt.toISOString(),
    qty: formatAmount(sale.qty),
    unmatchedQty: formatAmount(sale.unmatchedQty),
    proceedsUsd: money(sale.proceedsUsd),
    costUsd: blank(sale.assetId) ? null : money(sale.costUsd),
    realizedUsd: blank(sale.assetId) ? null : money(sale.realizedUsd),
    matches: sale.matches.map((m) => ({
      lotId: m.lotId,
      qty: formatAmount(m.qty),
      costUsd: blank(sale.assetId) ? null : money(m.costUsd),
      proceedsUsd: money(m.proceedsUsd),
      realizedUsd: blank(sale.assetId) ? null : money(m.realizedUsd),
    })),
  }));
  const now = (input.now ?? new Date()).getTime();
  const lots: BookLot[] = run.lots.map((lot) => ({
    id: lot.id,
    assetId: lot.assetId,
    acquiredAt: lot.acquiredAt.toISOString(),
    source: lot.source,
    qty: formatAmount(lot.qty),
    remaining: formatAmount(lot.remaining),
    costUsd: input.truncated ? null : money(lot.costUsd),
    remainingCostUsd: blank(lot.assetId) ? null : money(lot.remainingCostUsd),
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
  }));

  let realizedTotal: Amount | null = 0n;
  for (const sale of sales) {
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
    realizedUsd: sales.length === 0 ? null : realizedTotal === null ? null : formatAmount(realizedTotal),
    termRule: { status: 'unset', code: TAX_TERM_RULE_UNSET },
    residuals: [...residuals].sort(),
  };
}
