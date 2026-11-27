/**
 * Exchange parts for a trading desk: the order-book ladder and the trades tape. They draw only what they are given
 * (decimal strings, as the wire carries them) and read only `--lit-*` roles. Figures are tabular. They compute no money:
 * each level's depth bar is a ratio the caller worked out from the amounts.
 */
import * as React from 'react';
import { clsx } from 'clsx';

/** One price level; `depth` is the running total to this level over the deeper side's whole, "0" to "1". */
export type BookLevel = { readonly price: string; readonly amount: string; readonly depth?: string };
export type BookSide = 'bid' | 'ask';
type Marks = Record<`data-${string}`, string | undefined>;

export type BookLadderProps = {
  /** Asks, best (lowest) first; drawn highest at the top, so the best ask sits just above the spread. */
  asks: readonly BookLevel[];
  /** Bids, best (highest) first. */
  bids: readonly BookLevel[];
  /** A price or a size as the person reads it: fixed to the market's tick or lot, never rounded here. */
  formatPrice: (value: string) => string;
  formatAmount: (value: string) => string;
  labels: { caption: string; price: string; amount: string; spread: string; pick?: (price: string) => string };
  /** The spread row's figure (absolute and in basis points); the ladder never computes money itself. */
  spread?: React.ReactNode;
  /** A click on a level hands its price to the ticket. */
  onPick?: (price: string, side: BookSide) => void;
  rowMarks?: (level: BookLevel, side: BookSide) => Marks;
  priceMarks?: Marks;
  amountMarks?: Marks;
  className?: string;
};

/** The order book split around the mid: asks above, the spread, bids below, each level with its depth bar. */
export function BookLadder({
  asks,
  bids,
  formatPrice,
  formatAmount,
  labels,
  spread,
  onPick,
  rowMarks,
  priceMarks,
  amountMarks,
  className,
}: BookLadderProps) {
  const row = (level: BookLevel, side: BookSide) => {
    const style: React.CSSProperties & Record<`--${string}`, string> = { '--lt-depth': level.depth ?? '0' };
    return (
      <tr key={`${side}:${level.price}`} className="lt-book-row" data-book-side={side} style={style} {...rowMarks?.(level, side)}>
        <td className="lt-book-price lt-num" {...priceMarks}>
          {onPick ? (
            <button
              type="button"
              className="lt-book-pick"
              onClick={() => onPick(level.price, side)}
              aria-label={labels.pick?.(formatPrice(level.price))}
            >
              {formatPrice(level.price)}
            </button>
          ) : (
            formatPrice(level.price)
          )}
        </td>
        <td className="lt-book-amount lt-num" {...amountMarks}>
          {formatAmount(level.amount)}
        </td>
      </tr>
    );
  };
  return (
    <table className={clsx('lt-book', className)}>
      <caption className="lit-sr">{labels.caption}</caption>
      <thead>
        <tr>
          <th scope="col">{labels.price}</th>
          <th scope="col">{labels.amount}</th>
        </tr>
      </thead>
      <tbody className="lt-book-asks">{[...asks].reverse().map((l) => row(l, 'ask'))}</tbody>
      <tbody className="lt-book-mid">
        <tr>
          <th scope="row">{labels.spread}</th>
          <td className="lt-num">{spread ?? '—'}</td>
        </tr>
      </tbody>
      <tbody className="lt-book-bids">{bids.map((l) => row(l, 'bid'))}</tbody>
    </table>
  );
}

export type TapePrint = {
  readonly id: string;
  readonly price: string;
  readonly amount: string;
  readonly side: 'buy' | 'sell' | null;
  readonly time: string;
};

export type TradeTapeProps = {
  prints: readonly TapePrint[];
  formatPrice: (value: string) => string;
  formatAmount: (value: string) => string;
  labels: { caption: string; time: string; price: string; amount: string; side: (side: TapePrint['side']) => string };
  onPick?: (price: string) => void;
  rowMarks?: (print: TapePrint) => Marks;
  priceMarks?: Marks;
  amountMarks?: Marks;
  className?: string;
};

/** The market's prints, newest first: price in the taker's colour, size, and the time. */
export function TradeTape({
  prints,
  formatPrice,
  formatAmount,
  labels,
  onPick,
  rowMarks,
  priceMarks,
  amountMarks,
  className,
}: TradeTapeProps) {
  return (
    <table className={clsx('lt-tape', className)}>
      <caption className="lit-sr">{labels.caption}</caption>
      <thead>
        <tr>
          <th scope="col">{labels.price}</th>
          <th scope="col">{labels.amount}</th>
          <th scope="col">{labels.time}</th>
        </tr>
      </thead>
      <tbody>
        {prints.map((p) => (
          <tr key={p.id} className="lt-tape-row" data-taker={p.side ?? 'unknown'} {...rowMarks?.(p)}>
            <td className="lt-tape-price lt-num" {...priceMarks}>
              {onPick ? (
                <button type="button" className="lt-book-pick" onClick={() => onPick(p.price)}>
                  {formatPrice(p.price)}
                </button>
              ) : (
                formatPrice(p.price)
              )}
            </td>
            <td className="lt-num" {...amountMarks}>
              {formatAmount(p.amount)}
            </td>
            <td className="lt-num lt-tape-time">
              {p.time}
              <span className="lit-sr"> {labels.side(p.side)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
