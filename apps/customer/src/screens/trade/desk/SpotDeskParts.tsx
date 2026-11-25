import { Button, DateInput, Fold, StatStrip } from '@intafaced/ui/lit';
import { navigate } from '../../../app/location';
import { displayAmount } from '../../../shared/money';
import type { VenueMarket } from '../../../features/trade/venue-api';
import { TestMark } from '../../../features/trade/venue/VenueKit';
import { spotVenueCopy } from './venue-copy';
import { NotOfferedTypes, VenueSelfTradeSelect, VenueTifSelect } from './VenueOrderOptions';
import type { DeskTif, VenueOrderType } from './venue-desk';

/** The spot desk's top row: the venue's pairs as tiles, and what the person can spend and holds on this pair. */
export function SpotTopStrip({
  markets,
  market,
  test,
  freeQuote,
  freeBase,
}: {
  markets: readonly VenueMarket[];
  market: VenueMarket;
  test: boolean;
  /** Free quote and base on the venue, or null while the person is not connected. */
  freeQuote: string | null;
  freeBase: string | null;
}) {
  const { t } = spotVenueCopy.useCopy();
  return (
    <div className="xd-top">
      <ul className="xd-contracts" aria-label={t('Pairs')} data-testid="dk-pair-tiles">
        {(markets.length > 0 ? markets : [market]).slice(0, 6).map((m) => (
          <li key={m.symbol}>
            <Button
              tone="secondary"
              aria-pressed={m.symbol === market.symbol}
              onClick={() => m.symbol !== market.symbol && navigate(`/trade/spot/${m.symbol}`)}
            >
              <span className="xd-tile-symbol">
                {m.baseAsset}/{m.quoteAsset}
              </span>
              {/* A spot pair has no published mark: the tile shows its name only, never a dash for a price. */}
              {m.mark.known ? <span className="lt-num xd-tile-price">{displayAmount(m.mark.value)}</span> : null}
            </Button>
          </li>
        ))}
        <li>
          <TestMark test={test} />
        </li>
      </ul>
      <div className="xd-risk-row">
        <StatStrip
          dense
          cells={[
            {
              key: 'spend',
              label: t('To spend', { asset: market.quoteAsset }),
              value: freeQuote === null ? t('Connect to see') : `${displayAmount(freeQuote)} ${market.quoteAsset}`,
              num: freeQuote !== null,
              'data-testid': 'dk-to-spend',
            },
            {
              key: 'held',
              label: t('Held', { asset: market.baseAsset }),
              value: freeBase === null ? t('Connect to see') : `${displayAmount(freeBase)} ${market.baseAsset}`,
              num: freeBase !== null,
              'data-testid': 'dk-held',
            },
          ]}
        />
      </div>
    </div>
  );
}

/** The ticket's Order options fold: time in force, its expiry, self-trade, and the kinds this venue doesn't offer. */
export function SpotTicketOptions({
  market,
  activeType,
  tif,
  onTif,
  expiry,
  onExpiry,
  expireAt,
  marketDisabledReason,
}: {
  market: VenueMarket;
  activeType: VenueOrderType;
  tif: DeskTif;
  onTif: (next: DeskTif) => void;
  expiry: string;
  onExpiry: (next: string) => void;
  /** The expiry as the venue takes it, or null when the field holds no future time. */
  expireAt: string | null;
  marketDisabledReason: string | null;
}) {
  const { t } = spotVenueCopy.useCopy();
  // The order's finer terms (time in force, what the venue does when it meets your own order) and the kinds this
  // venue doesn't offer: there when asked for, off the ticket's face.
  return (
    <Fold title={t('Order options')} data-testid="venue-ticket-options">
      <div className="lt-stack">
        <NotOfferedTypes market={market} marketDisabledReason={marketDisabledReason} />
        {activeType === 'limit' ? (
          <div className="lt-row">
            <VenueTifSelect market={market} tif={tif} onTif={onTif} />
            {tif === 'GTD' ? (
              <label className="lt-field">
                <span>{t('Expires')}</span>
                <DateInput
                  type="datetime-local"
                  value={expiry}
                  onChange={(event) => onExpiry(event.target.value)}
                  aria-label={t('Expires')}
                  aria-invalid={expiry !== '' && expireAt === null}
                />
                {expiry !== '' && expireAt === null ? (
                  <span className="lt-note lt-note-bad" role="note">
                    {t('Expiry past')}
                  </span>
                ) : null}
              </label>
            ) : null}
          </div>
        ) : null}
        <VenueSelfTradeSelect market={market} />
      </div>
    </Fold>
  );
}
