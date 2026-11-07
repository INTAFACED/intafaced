/**
 * Buy and Sell on the chart (J-charts-desk-14 #5, #6, #7, C-trade-dom-02).
 *
 * - Each button carries the live touch price and the spread between them, from the desk's own book. A press fills the
 *   desk's ticket with a draft and opens its review. An order type the market does not take (trailing stop, tif.ts)
 *   refuses with the desk's own reason (`trade.order_type_unsupported`) and makes no draft.
 * - Instant placement is off by default. Turning it on shows the settings summary first and is stored with the time the
 *   person agreed; then a click sends a checked LIMIT order with no review. A market order (Buy or Sell at market,
 *   Close) always shows its review, as the desk's order summary rule has it (J-cex-spot-13 #2). Off, every click
 *   reviews. Turning it off needs nothing.
 * - Size presets are the person's own quick sizes (Account, Trading settings): a press sets the click amount, once.
 * - Close sells every free lot of the base at market through the desk's own Flatten, reviewed or instant.
 */
import { memo, useId, useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  fmtAmount,
  fmtPrice,
  refusalCopy,
} from './deps';
import type { DeskMarket } from './market';
import { flowCopy } from './order-flow-copy';
import { spreadOf, type InstantSetting } from './order-flow';
import { scaled, type Reference } from './order-math';
import { placesOf } from './text';
import { UNSUPPORTED_TYPES } from './tif';

export type ChartOrderType = 'market' | 'limit' | (typeof UNSUPPORTED_TYPES)[number];

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
  market: DeskMarket;
  reference: Reference | null;
  amount: string;
  onAmount: (amount: string) => void;
  onTrade: (pick: ChartPick) => void;
  instant: InstantSetting;
  onInstant: (next: InstantSetting) => void;
  /** The person's quick sizes, in the base asset. */
  presets: readonly string[];
  /** Free base to close, or null while it is unknown or the desk does not offer a close on this market now. */
  closable: string | null;
  onClose: () => void;
}

export const ChartTrade = memo(function ChartTrade({
  market,
  reference,
  amount,
  onAmount,
  onTrade,
  instant,
  onInstant,
  presets,
  closable,
  onClose,
}: Props) {
  const { t } = flowCopy.useCopy();
  const id = useId();
  const [type, setType] = useState<ChartOrderType>('market');
  const [note, setNote] = useState<{ tone: 'bad'; text: string; code?: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const bid = reference?.bestBid ?? null;
  const ask = reference?.bestAsk ?? null;
  const spread = spreadOf(bid, ask);
  const spreadId = `${id}-spread`;
  const amountPlaces = placesOf(market.lotSize);
  const closeOk = closable !== null && (scaled(closable) ?? 0n) > 0n;

  const press = (side: 'buy' | 'sell') => {
    setNote(null);
    if (type !== 'market' && type !== 'limit') {
      const words = refusalCopy('trade.order_type_unsupported');
      setNote({ tone: 'bad', text: `${words.title}. ${words.body}`, code: 'trade.order_type_unsupported' });
      return;
    }
    if (amount.trim() === '') return setNote({ tone: 'bad', text: t('Click amount first') });
    if (!clickAmountOk(amount, market.lotSize)) return setNote({ tone: 'bad', text: t('Click amount invalid', { lot: market.lotSize }) });
    const touch = side === 'buy' ? ask : bid;
    if (type === 'limit' && touch === null) return;
    onTrade({ side, type, price: type === 'limit' ? (touch ?? '') : '', amount: amount.trim() });
  };

  const agreedText = instant.agreedAt ? new Date(instant.agreedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';

  return (
    <div className="of-trade" role="group" aria-label={t('Trade from the chart')} data-testid="of-chart-trade">
      <button
        type="button"
        className="of-sell"
        data-testid="of-chart-sell"
        data-price={bid ?? ''}
        aria-describedby={spreadId}
        disabled={!market.open || bid === null}
        onClick={() => press('sell')}
      >
        {t('Chart sell', { price: bid === null ? t('Chart no price') : fmtPrice(bid, market.tickSize) })}
      </button>
      <span id={spreadId} className="of-spread" data-testid="of-chart-spread" data-spread={spread ?? ''}>
        {spread === null ? t('Spread none') : t('Spread', { spread: fmtPrice(spread, market.tickSize) })}
      </span>
      <button
        type="button"
        className="of-buy"
        data-testid="of-chart-buy"
        data-price={ask ?? ''}
        aria-describedby={spreadId}
        disabled={!market.open || ask === null}
        onClick={() => press('buy')}
      >
        {t('Chart buy', { price: ask === null ? t('Chart no price') : fmtPrice(ask, market.tickSize) })}
      </button>
      <label className="of-field">
        <span>{t('Order type')}</span>
        <select
          value={type}
          onChange={(event) => {
            setType(event.target.value as ChartOrderType);
            setNote(null);
          }}
        >
          <option value="market">{t('Type market')}</option>
          <option value="limit">{t('Type limit')}</option>
          {UNSUPPORTED_TYPES.map((kind) => (
            <option key={kind} value={kind}>
              {t('Type trailing')}
            </option>
          ))}
        </select>
      </label>
      <label className="of-field">
        <span>{t('Click amount', { asset: market.base })}</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(event) => {
            onAmount(event.target.value);
            setNote(null);
          }}
        />
      </label>
      <div className="of-presets" role="group" aria-label={t('Size presets')}>
        {presets.length === 0 ? (
          <span className="of-note">{t('Size presets none')}</span>
        ) : (
          presets.map((size) => (
            <button
              key={size}
              type="button"
              aria-pressed={amount.trim() === size}
              aria-label={t('Size preset', { size, asset: market.base })}
              disabled={!clickAmountOk(size, market.lotSize)}
              onClick={() => {
                onAmount(size);
                setNote(null);
              }}
            >
              {size}
            </button>
          ))
        )}
      </div>
      <button
        type="button"
        className="of-close-position"
        data-testid="of-chart-close"
        disabled={!closeOk}
        title={closeOk ? undefined : t('Close none', { asset: market.base })}
        onClick={onClose}
      >
        {t('Close position', { asset: market.base })}
        {closeOk ? ` · ${fmtAmount(closable!, { places: amountPlaces })}` : ''}
      </button>
      <button type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
        {t('Trading settings')}
      </button>
      {instant.on ? (
        <span className="of-instant-badge" data-testid="of-instant-on" data-agreed-at={instant.agreedAt ?? ''}>
          {t('Instant placement')}
        </span>
      ) : null}
      {settingsOpen ? (
        <div className="of-settings" role="region" aria-label={t('Trading settings')}>
          <button
            type="button"
            role="switch"
            aria-checked={instant.on}
            aria-describedby={`${id}-instant`}
            onClick={() => (instant.on ? onInstant({ on: false, agreedAt: null }) : setAsking(true))}
          >
            {t('Instant placement')}
          </button>
          <p id={`${id}-instant`} className="of-note" data-testid="of-instant-note">
            {instant.on ? t('Instant on note', { time: agreedText }) : t('Instant off note')}
          </p>
        </div>
      ) : null}
      {note ? (
        <p className="of-trade-note" role="status" data-testid="of-chart-note" data-tone={note.tone} data-code={note.code}>
          {note.text}
        </p>
      ) : null}
      <AlertDialog open={asking} onOpenChange={(open) => !open && setAsking(false)}>
        {asking ? (
          <AlertDialogContent className="dk-review" data-testid="of-instant-summary">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Instant summary title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('Instant summary intro')}</AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="of-summary">
              <li>{t('Instant summary send')}</li>
              <li>{t('Instant summary market')}</li>
              <li>{t('Instant summary close')}</li>
              <li>{t('Instant summary checks')}</li>
              <li>
                {clickAmountOk(amount, market.lotSize)
                  ? t('Instant summary amount', { amount: amount.trim(), asset: market.base })
                  : t('Instant summary amount none')}
              </li>
              <li>{t('Instant summary off')}</li>
            </ul>
            <AlertDialogFooter>
              <Button variant="secondary" size={40} onClick={() => setAsking(false)}>
                {t('Instant keep reviewing')}
              </Button>
              <Button
                variant="primary"
                size={40}
                onClick={() => {
                  onInstant({ on: true, agreedAt: new Date().toISOString() });
                  setAsking(false);
                }}
              >
                {t('Instant turn on')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
});
