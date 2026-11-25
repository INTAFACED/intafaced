/**
 * Buy and Sell on the chart (J-charts-desk-14 #5, C-trade-dom-02): each button carries the live touch price and the
 * spread between them, from the desk's own book. A press fills the desk's ticket with a draft and opens its review; it
 * never sends by itself. An order type the market does not take (trailing stop, tif.ts) refuses with the desk's own
 * reason (`trade.order_type_unsupported`) and makes no draft.
 */
import { memo, useId, useState } from 'react';
import { Button, fmtPrice, refusalCopy } from './deps';
import { flowCopy } from './order-flow-copy';
import { spreadOf, type FlowMarket } from './order-flow';
import { scaled, type Reference } from './order-math';
import { UNSUPPORTED_TYPES } from './tif';
import { shownTick } from '../chart/chart-data';

export type ChartOrderType = 'market' | 'limit' | string;

/**
 * An order type the chart lists that this market does not take: its name in the kind list, and the reason (with its code)
 * a press shows instead of making a draft.
 */
export interface RefusedChartType {
  id: string;
  label: string;
  reason: string;
  code: string;
}

export interface ChartPick {
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  /** The touch price for a limit; '' for a market order. */
  price: string;
  amount: string;
}

/** An amount the ticket can take: a positive decimal on the lot size. */
export function clickAmountOk(amount: string, lotSize: string): boolean {
  const value = scaled(amount.trim());
  const lot = scaled(lotSize);
  return value !== null && lot !== null && lot > 0n && value > 0n && value % lot === 0n;
}

interface Props {
  market: FlowMarket;
  reference: Reference | null;
  amount: string;
  onAmount: (amount: string) => void;
  onTrade: (pick: ChartPick) => void;
  /** The types this market refuses; none given, today's desk's (trailing stop, `trade.order_type_unsupported`). */
  refused?: readonly RefusedChartType[];
}

export const ChartTrade = memo(function ChartTrade({ market, reference, amount, onAmount, onTrade, refused }: Props) {
  const { t } = flowCopy.useCopy();
  const todays = (): RefusedChartType[] => {
    const words = refusalCopy('trade.order_type_unsupported');
    return UNSUPPORTED_TYPES.map((kind) => ({
      id: kind,
      label: t('Type trailing'),
      reason: `${words.title}. ${words.body}`,
      code: 'trade.order_type_unsupported',
    }));
  };
  const refusedTypes = refused ?? todays();
  const id = useId();
  const [type, setType] = useState<ChartOrderType>('market');
  const [note, setNote] = useState<{ tone: 'bad'; text: string; code?: string } | null>(null);
  const bid = reference?.bestBid ?? null;
  const ask = reference?.bestAsk ?? null;
  const spread = spreadOf(bid, ask);
  const spreadId = `${id}-spread`;

  const press = (side: 'buy' | 'sell') => {
    setNote(null);
    if (type !== 'market' && type !== 'limit') {
      const why = refusedTypes.find((kind) => kind.id === type);
      if (why) setNote({ tone: 'bad', text: why.reason, code: why.code });
      return;
    }
    if (amount.trim() === '') return setNote({ tone: 'bad', text: t('Click amount first') });
    if (!clickAmountOk(amount, market.lotSize)) return setNote({ tone: 'bad', text: t('Click amount invalid', { lot: market.lotSize }) });
    const touch = side === 'buy' ? ask : bid;
    if (type === 'limit' && touch === null) return;
    onTrade({ side, type, price: type === 'limit' ? (touch ?? '') : '', amount: amount.trim() });
  };

  return (
    <div className="lt-row" role="group" aria-label={t('Trade from the chart')} data-testid="of-chart-trade">
      <Button
        tone="down"
        size="sm"
        data-testid="of-chart-sell"
        data-price={bid ?? ''}
        aria-describedby={spreadId}
        disabled={!market.open || bid === null}
        onClick={() => press('sell')}
      >
        {t('Chart sell', { price: bid === null ? t('Chart no price') : fmtPrice(bid, shownTick(market.tickSize, bid)) })}
      </Button>
      <span id={spreadId} className="lt-num lt-note" data-testid="of-chart-spread" data-spread={spread ?? ''}>
        {spread === null ? t('Spread none') : t('Spread', { spread: fmtPrice(spread, shownTick(market.tickSize, bid)) })}
      </span>
      <Button
        tone="up"
        size="sm"
        data-testid="of-chart-buy"
        data-price={ask ?? ''}
        aria-describedby={spreadId}
        disabled={!market.open || ask === null}
        onClick={() => press('buy')}
      >
        {t('Chart buy', { price: ask === null ? t('Chart no price') : fmtPrice(ask, shownTick(market.tickSize, ask)) })}
      </Button>
      <label className="lt-field">
        {/* One compact tools row under the chart: the field's name is read out, its value shows. */}
        <span data-sr-only="">{t('Order type')}</span>
        <select
          value={type}
          onChange={(event) => {
            setType(event.target.value as ChartOrderType);
            setNote(null);
          }}
        >
          <option value="market">{t('Type market')}</option>
          <option value="limit">{t('Type limit')}</option>
          {refusedTypes.map((kind) => (
            <option key={kind.id} value={kind.id}>
              {kind.label}
            </option>
          ))}
        </select>
      </label>
      <label className="lt-field">
        <span data-sr-only="">{t('Click amount', { asset: market.base })}</span>
        <input
          type="text"
          placeholder={t('Click amount', { asset: market.base })}
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(event) => {
            onAmount(event.target.value);
            setNote(null);
          }}
        />
      </label>
      {note ? (
        <p className="lt-note lt-note-bad" role="status" data-testid="of-chart-note" data-tone={note.tone} data-code={note.code}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
});
