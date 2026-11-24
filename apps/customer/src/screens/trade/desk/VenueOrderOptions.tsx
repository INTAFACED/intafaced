import type { VenueMarket, VenueSelfTradeMode } from '../../../features/trade/venue-api';
import { word } from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { Button } from '@intafaced/ui/lit';
import { Select } from '@intafaced/ui/lit/templates';
import { spotVenueCopy } from './venue-copy';
import {
  OTHER_ORDER_TYPES,
  SELF_TRADE_MODES,
  TIME_IN_FORCE_NAMES,
  deskTif,
  offeredTif,
  venueSelfTrade,
  type DeskTif,
  type TimeInForceName,
} from './venue-desk';

// The venue spot desk's order options (J-cex-spot-03): every order type, time in force and self-trade rule the desk
// names, each the venue offers on the market pickable, the rest listed disabled with "not offered by this venue". A
// disabled choice signs and sends nothing: it can't be picked. Good till date, which the venue lacks, is run by
// INTAFACED instead, by the owner's choice, and says so.

/** The order types beside limit and market that the venue does not list, each a disabled button saying so. */
export function NotOfferedTypes({ market }: { market: VenueMarket }) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const missing = OTHER_ORDER_TYPES.filter((x) => !market.orderTypes.includes(x));
  if (missing.length === 0) return null;
  return (
    <div role="group" aria-label={t('Order types more')} data-testid="venue-order-types" className="lt-row">
      {missing.map((x) => (
        <Button key={x} tone="secondary" size="sm" disabled aria-disabled="true" data-not-offered={x}>
          {word(v, 'type', x)}: {v('Not offered')}
        </Button>
      ))}
    </div>
  );
}

/**
 * A label for a time in force: its name; "run by INTAFACED" where our engine runs it in the venue's place; "not offered
 * by this venue" where neither does.
 */
function tifLabel(v: ReturnType<typeof venueCopy.useCopy>['t'], engine: string, market: VenueMarket, name: TimeInForceName): string {
  const shown = word(v, 'tif', name);
  if (offeredTif(market, name)) return shown;
  return deskTif(market, name) ? `${shown} · ${engine}` : `${shown} · ${v('Not offered')}`;
}

/** Time in force for a limit order, picked once for both tickets. */
export function VenueTifSelect({ market, tif, onTif }: { market: VenueMarket; tif: DeskTif; onTif: (next: DeskTif) => void }) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  return (
    <div className="lt-field" data-testid="venue-tif">
      <span className="lt-label" id="venue-tif-label">
        {t('Time in force')}
      </span>
      <Select
        size="sm"
        labelledBy="venue-tif-label"
        value={tif}
        onChange={(next) => {
          const offered = deskTif(market, next as TimeInForceName);
          if (offered && offered !== tif) onTif(offered);
        }}
        options={TIME_IN_FORCE_NAMES.map((name) => ({
          value: name,
          label: tifLabel(v, t('Tif engine'), market, name),
          disabled: deskTif(market, name) === null,
          data: { 'data-tif': name },
        }))}
      />
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
  return (
    <div className="lt-field" data-testid="venue-self-trade">
      <span className="lt-label" id="venue-stp-label">
        {t('Self trade')}
      </span>
      <Select
        size="sm"
        labelledBy="venue-stp-label"
        describedBy="venue-stp-note"
        value={rule ?? ''}
        placeholder={v('Not published')}
        options={SELF_TRADE_MODES.map((mode) => ({
          value: mode,
          label: label(mode),
          disabled: mode !== rule,
          data: { 'data-mode': mode },
        }))}
      />
      <span className="lt-note" id="venue-stp-note">
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
    <div role="group" aria-label={t('Amount in')} className="lt-row" data-testid="venue-unit">
      {(['base', 'quote'] as const).map((x) => (
        <Button
          key={x}
          type="button"
          size="sm"
          tone={unit === x ? 'primary' : 'secondary'}
          aria-pressed={unit === x}
          onClick={() => onUnit(x)}
        >
          {x === 'base' ? base : quote}
        </Button>
      ))}
    </div>
  );
}
