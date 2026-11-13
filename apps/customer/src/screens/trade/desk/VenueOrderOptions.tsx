import type { GoodTillDate, VenueMarket, VenueSelfTradeMode } from '../../../features/trade/venue-api';
import { word } from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './deps';
import { spotVenueCopy } from './venue-copy';
import {
  OTHER_ORDER_TYPES,
  SELF_TRADE_MODES,
  TIME_IN_FORCE_NAMES,
  offeredTif,
  ourGoodTillDate,
  venueSelfTrade,
  type DeskTif,
  type TimeInForceName,
} from './venue-desk';

// The venue spot desk's order options (J-cex-spot-03): every order type, time in force and self-trade rule the desk
// names, each the venue offers on the market pickable, the rest listed disabled with "not offered by this venue". A
// disabled choice signs and sends nothing: it can't be picked.

/** The order types beside limit and market that the venue does not list, each a disabled button saying so. */
export function NotOfferedTypes({ market }: { market: VenueMarket }) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const missing = OTHER_ORDER_TYPES.filter((x) => !market.orderTypes.includes(x));
  if (missing.length === 0) return null;
  return (
    <div role="group" aria-label={t('Order types more')} data-testid="venue-order-types" className="dk-order-opts">
      {missing.map((x) => (
        <Button key={x} variant="secondary" size={32} disabled aria-disabled="true" data-not-offered={x}>
          {word(v, 'type', x)}: {v('Not offered')}
        </Button>
      ))}
    </div>
  );
}

/** A label for a time in force: its name, with "not offered by this venue" where the venue doesn't take it. */
function tifLabel(
  v: ReturnType<typeof venueCopy.useCopy>['t'],
  t: ReturnType<typeof spotVenueCopy.useCopy>['t'],
  market: VenueMarket,
  name: TimeInForceName,
): string {
  // Our good-till-date says whose it is: the venue offers none, and our service cancels at the expiry.
  if (name === 'GTD' && ourGoodTillDate(market)) return t('GTD ours');
  const shown = word(v, 'tif', name);
  return offeredTif(market, name) ? shown : `${shown} · ${v('Not offered')}`;
}

/** Time in force for a limit order, picked once for both tickets. */
export function VenueTifSelect({ market, tif, onTif }: { market: VenueMarket; tif: DeskTif; onTif: (next: DeskTif) => void }) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const items = Object.fromEntries(TIME_IN_FORCE_NAMES.map((name) => [name, tifLabel(v, t, market, name)]));
  return (
    <div className="dk-tif dk-opt" data-testid="venue-tif">
      <span className="dk-tif-label" id="venue-tif-label">
        {t('Time in force')}
      </span>
      <Select
        items={items}
        value={tif}
        onValueChange={(next) => {
          const offered = next ? offeredTif(market, next as TimeInForceName) : null;
          if (offered && offered !== tif) onTif(offered);
        }}
      >
        <SelectTrigger size={32} className="dk-tif-trigger" aria-labelledby="venue-tif-label">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {TIME_IN_FORCE_NAMES.map((name) => (
            <SelectItem key={name} value={name} disabled={offeredTif(market, name) === null} data-tif={name}>
              {items[name]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** What an order does when it would meet the person's own resting order: the venue's own rule, the others disabled. */
export function VenueSelfTradeSelect({ market }: { market: VenueMarket }) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const rule = venueSelfTrade(market);
  const label = (mode: VenueSelfTradeMode) =>
    mode === rule ? word(v, 'stp', mode) : `${word(v, 'stp', mode)} · ${rule === null ? v('Not published') : v('Not offered')}`;
  const items = Object.fromEntries(SELF_TRADE_MODES.map((mode) => [mode, label(mode)]));
  return (
    <div className="dk-tif dk-opt" data-testid="venue-self-trade">
      <span className="dk-tif-label" id="venue-stp-label">
        {t('Self trade')}
      </span>
      <Select items={items} value={rule ?? ''}>
        <SelectTrigger size={32} className="dk-tif-trigger" aria-labelledby="venue-stp-label" aria-describedby="venue-stp-note">
          <SelectValue placeholder={v('Not published')} />
        </SelectTrigger>
        <SelectContent align="start">
          {SELF_TRADE_MODES.map((mode) => (
            <SelectItem key={mode} value={mode} disabled={mode !== rule} data-mode={mode}>
              {items[mode]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="dk-opt-note" id="venue-stp-note">
        {t('Self trade note')}
      </span>
    </div>
  );
}

/** Which field the person types the order's size in: the base asset (Amount) or the quote asset (Total or Spend). */
export function UnitFlag({
  unit,
  base,
  quote,
  onUnit,
}: {
  unit: 'base' | 'quote';
  base: string;
  quote: string;
  onUnit: (next: 'base' | 'quote') => void;
}) {
  const { t } = spotVenueCopy.useCopy();
  return (
    <div role="group" aria-label={t('Amount in')} className="dk-order-opts" data-testid="venue-unit">
      {(['base', 'quote'] as const).map((x) => (
        <Button
          key={x}
          type="button"
          size={32}
          variant={unit === x ? 'primary' : 'secondary'}
          aria-pressed={unit === x}
          onClick={() => onUnit(x)}
        >
          {x === 'base' ? base : quote}
        </Button>
      ))}
    </div>
  );
}

/** Our good-till-date's expiry, in the device's local time (J-cex-spot-03 #7). */
export function VenueExpiryInput({ value, onValue }: { value: string; onValue: (next: string) => void }) {
  const { t } = spotVenueCopy.useCopy();
  return (
    <label className="dk-tif dk-opt" data-testid="venue-expiry">
      <span className="dk-tif-label">{t('Expires at')}</span>
      <input
        type="datetime-local"
        step={1}
        className="dk-expiry-input"
        value={value}
        onChange={(event) => onValue(event.target.value)}
        aria-label={t('Expires at')}
        aria-describedby="venue-expiry-note"
      />
      <span className="dk-opt-note" id="venue-expiry-note">
        {t('Expiry note')}
      </span>
    </label>
  );
}

/** The person's good-till-date orders on this market: each expiry, and what our cancel at it did. */
export function GoodTillDates({ rows, clock }: { rows: GoodTillDate[]; clock: (iso: string) => string }) {
  const { t } = spotVenueCopy.useCopy();
  if (rows.length === 0) return null;
  return (
    <section aria-label={t('GTD orders')} data-testid="venue-gtd" className="form-stack">
      <h3 className="dk-tab-title">{t('GTD orders')}</h3>
      <ul>
        {rows.map((g) => {
          const time = clock(g.expiresAt);
          const text =
            g.state === 'scheduled'
              ? t('GTD scheduled', { time })
              : g.state === 'due'
                ? t('GTD due', { time })
                : g.state === 'expired'
                  ? t('GTD expired', { time })
                  : g.state === 'not_open'
                    ? t('GTD not open', { time })
                    : t('GTD failed', { time, detail: g.refusal?.detail ?? '' });
          return (
            <li key={g.actionKey} data-client-order-id={g.venueClientOrderId ?? ''} data-state={g.state} data-expires-at={g.expiresAt}>
              {text}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
