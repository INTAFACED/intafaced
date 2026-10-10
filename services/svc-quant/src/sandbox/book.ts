import { add, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import { QUANT_VENUE_VAULT_UNSET, QuantError } from '../errors.js';

export interface PaperFill {
  readonly side: 'buy' | 'sell';
  readonly symbol: string;
  readonly qty: string;
  readonly price: string;
  readonly venue: 'internal';
}

export interface PaperBook {
  last(symbol: string): string;
  bid(symbol: string): string;
  ask(symbol: string): string;
  buy(symbol: string, qty: string): PaperFill;
  sell(symbol: string, qty: string): PaperFill;
  venueBuy(symbol: string, qty: string): PaperFill;
  venueSell(symbol: string, qty: string): PaperFill;
  cash(): string;
  position(symbol: string): string;
  pnl(): string;
  fills(): readonly PaperFill[];
}

export interface PaperBookOptions {
  readonly startingCash: string;
  readonly marks?: Readonly<Record<string, string>>;
  /** When false, venue OMS refuses `quant.venue_vault_unset`. */
  readonly venueVaultSet: boolean;
}

export function createPaperBook(options: PaperBookOptions): PaperBook {
  const marks = { ...(options.marks ?? {}) };
  let cash: Amount = parseAmount(options.startingCash);
  const starting = cash;
  const positions = new Map<string, Amount>();
  const fills: PaperFill[] = [];

  const markOf = (symbol: string): Amount => {
    const m = marks[symbol];
    if (!m) throw new QuantError('quant.params_invalid', `unknown symbol ${symbol}`);
    return parseAmount(m);
  };

  const fill = (side: 'buy' | 'sell', symbol: string, qtyRaw: string): PaperFill => {
    const qty = parseAmount(qtyRaw);
    if (qty <= 0n) throw new QuantError('quant.params_invalid', 'qty must be a positive decimal string');
    const price = markOf(symbol);
    const notional = mul(qty, price, 'half-up');
    const pos = positions.get(symbol) ?? 0n;
    if (side === 'buy') {
      cash = sub(cash, notional);
      positions.set(symbol, add(pos, qty));
    } else {
      cash = add(cash, notional);
      positions.set(symbol, sub(pos, qty));
    }
    const row: PaperFill = { side, symbol, qty: formatAmount(qty), price: formatAmount(price), venue: 'internal' };
    fills.push(row);
    return row;
  };

  const venue = (_side: 'buy' | 'sell', _symbol: string, _qty: string): PaperFill => {
    if (!options.venueVaultSet) {
      throw new QuantError(
        QUANT_VENUE_VAULT_UNSET,
        'Venue Vault unset — internal book still runs; venue OMS is trade-only when QUANT_VENUE_VAULT is set',
      );
    }
    // Env is set, but this process still has no vault unwrap. Refuse rather
    // than paint an external fill that never left the paper book.
    throw new QuantError(QUANT_VENUE_VAULT_UNSET, 'Venue Vault pin is set but trade-only unwrap is not wired — internal book still runs');
  };

  return {
    last: (symbol) => formatAmount(markOf(symbol)),
    bid: (symbol) => formatAmount(markOf(symbol)),
    ask: (symbol) => formatAmount(markOf(symbol)),
    buy: (symbol, qty) => fill('buy', symbol, qty),
    sell: (symbol, qty) => fill('sell', symbol, qty),
    venueBuy: (symbol, qty) => venue('buy', symbol, qty),
    venueSell: (symbol, qty) => venue('sell', symbol, qty),
    cash: () => formatAmount(cash),
    position: (symbol) => formatAmount(positions.get(symbol) ?? 0n),
    pnl: () => {
      let equity = cash;
      for (const [symbol, qty] of positions) {
        equity = add(equity, mul(qty, markOf(symbol), 'half-up'));
      }
      return formatAmount(sub(equity, starting));
    },
    fills: () => fills,
  };
}
