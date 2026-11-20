import { displayAmount } from '../../../shared/money';
import { type AsOf, type OrderIntent, type VenuePreview, type VenueSelfTradeMode, type VenueUp } from '../../../features/trade/venue-api';
import { Known, TestMark, word } from '../../../features/trade/venue/VenueKit';
import { rateShown } from '../../../features/trade/venue/fee-rates';
import { bpsPercent, carriesBuilderFee } from '../../../features/trade/venue/VenueReview';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { spotVenueCopy } from './venue-copy';
import { useClock } from './VenueAccountPanel';

const baseOf = (symbol: string) => symbol.split('-')[0] ?? symbol;
const quoteOf = (symbol: string) => symbol.split('-')[1] ?? '';

/** A venue rate from the preview: the percent, "Zero fee", or the venue's rebate; "not known" where it publishes none. */
function rateText(
  t: ReturnType<typeof spotVenueCopy.useCopy>['t'],
  v: ReturnType<typeof venueCopy.useCopy>['t'],
  rate: { known: true; value: string } | { known: false },
): string {
  if (!rate.known) return v('Not known');
  const shown = rateShown(rate.value);
  return shown.kind === 'zero'
    ? t('Rate zero')
    : shown.kind === 'rebate'
      ? t('Rate rebate', { pct: shown.value })
      : t('Rate pct', { pct: shown.value });
}

/**
 * J-cex-spot-10 #9: the fee currency choice. At launch the venue charges its fee in the fill's own coin and INTAFACED holds
 * none of the person's coins, so paying in IFC is shown, disabled, with its reason; pressing it sends nothing.
 */
export function FeeCurrencyRow() {
  const { t } = spotVenueCopy.useCopy();
  return (
    <section className="dk-panel form-stack" aria-label={t('Fee currency')} data-testid="venue-fee-currency">
      <h2 className="dk-tab-title">{t('Fee currency')}</h2>
      <p data-line="fee-currency-venue">{t('Fee currency venue')}</p>
      <button type="button" className="button" disabled aria-describedby="venue-fee-currency-ifc-reason" data-fee-currency="IFC">
        {t('Fee currency IFC')}
      </button>
      <p id="venue-fee-currency-ifc-reason" className="muted">
        {t('Fee currency IFC reason')}
      </p>
    </section>
  );
}

/** The review's lines, all from the venue's preview (a builder fee with no approval says so). */
export function VenueReviewRows({
  intent,
  preview,
  status,
  approved,
  protectionBps = null,
  selfTrade = null,
  tag = '',
}: {
  intent: OrderIntent;
  preview: AsOf<VenuePreview>;
  status: Pick<VenueUp, 'builder' | 'test'>;
  approved: boolean | null;
  /** The owner's market price protection in bps the worst price was set from; shown on a market order. */
  protectionBps?: string | null;
  /** The venue's own self-trade rule on the market, or null where it publishes none. */
  selfTrade?: VenueSelfTradeMode | null;
  /** The person's own tag on the order, or blank. */
  tag?: string;
}) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const clock = useClock();
  const p = preview.value;
  const carries = carriesBuilderFee(p.builderFee);
  return (
    <div data-testid="venue-review" className="form-stack">
      <TestMark test={status.test} />
      <dl className="protocol-facts">
        <div>
          <dt>{t('Venue locks')}</dt>
          <dd className="numeric" data-line="lock">
            {displayAmount(p.lock.amount)} {p.lock.asset}
          </dd>
        </div>
        <div>
          <dt>{t('Venue fee')}</dt>
          <dd className="numeric" data-line="venue-fee">
            <Known value={p.venueFee.known ? { known: true, value: p.venueFee.value.amount } : { known: false }} />{' '}
            {p.venueFee.known ? p.venueFee.value.asset : ''}
          </dd>
        </div>
        <div>
          <dt>{t('Our builder fee')}</dt>
          <dd className="numeric" data-line="builder-fee">
            {!carries ? (
              v('Builder none spot buy')
            ) : status.builder ? (
              <>
                <Known value={p.builderFee.known ? { known: true, value: p.builderFee.value.amount } : { known: false }} />{' '}
                {p.builderFee.known ? p.builderFee.value.asset : ''}
                {approved === false ? ` · ${v('Builder not approved', { bps: status.builder.feeBps })}` : ''}
              </>
            ) : (
              <span role="alert">{v('Builder fee owner blank')}</span>
            )}
          </dd>
        </div>
        {carries && p.feeDiscount ? (
          <div>
            <dt>{v('Builder fee discount')}</dt>
            <dd className="numeric" data-line="builder-fee-discount" data-source={p.feeDiscount.source}>
              {p.feeDiscount.source === 'coupon'
                ? v('Builder discount coupon', { code: p.feeDiscount.code, pct: bpsPercent(p.feeDiscount.bps) })
                : v('Builder discount rank', { pct: bpsPercent(p.feeDiscount.bps) })}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t('Venue rates')}</dt>
          <dd data-line="venue-rates">
            {p.rates ? (
              t('Venue rates line', { maker: rateText(t, v, p.rates.makerFeeBps), taker: rateText(t, v, p.rates.takerFeeBps) })
            ) : (
              <Known value={{ known: false }} />
            )}
          </dd>
        </div>
        <div>
          <dt>{t('Fee role')}</dt>
          <dd data-line="role">{word(v, 'role', p.role)}</dd>
        </div>
        <div>
          <dt>{t('Time in force')}</dt>
          <dd data-line="tif">{word(v, 'tif', intent.timeInForce)}</dd>
        </div>
        {intent.type === 'market' ? (
          <div>
            <dt>{t('Worst price review')}</dt>
            <dd className="numeric" data-line="worst">
              {displayAmount(intent.price)}
            </dd>
          </div>
        ) : null}
        {intent.type === 'market' && protectionBps !== null ? (
          <div>
            <dt>{t('Price protection')}</dt>
            <dd data-line="protection">
              {t(intent.side === 'buy' ? 'Protection buy' : 'Protection sell', {
                price: displayAmount(intent.price),
                quote: quoteOf(intent.symbol),
                base: baseOf(intent.symbol),
                bps: protectionBps,
              })}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t('Self trade review')}</dt>
          <dd data-line="self-trade">{selfTrade ? word(v, 'stp', selfTrade) : v('Not published')}</dd>
        </div>
        {tag ? (
          <div>
            <dt>{t('Tag review')}</dt>
            <dd data-line="tag">{tag}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t('Client id')}</dt>
          <dd className="numeric" data-line="client-id" data-testid="client-order-id">
            {intent.clientOrderKey}
          </dd>
        </div>
        <div>
          <dt>{t('As of')}</dt>
          <dd className="numeric">{clock(preview.asOf)}</dd>
        </div>
      </dl>
    </div>
  );
}
