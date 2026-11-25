import { Button } from '@intafaced/ui/lit';
import { fmtAmount, fmtPct, fmtPrice, fmtUsd, type MarketRow } from '../../../data';
import type { Draft, Preview } from '../../../features/trade/trade-api';
import { KitDialog } from '../kit-parts';
import { buyCopy } from './copy';
import { costRows, spreadOf } from './cost';
import { formatGet } from './cost-format';
import { fractionDigits } from './trade-math';

export interface ReviewState {
  draft: Draft;
  preview: Preview;
  /** The price the order was sized from, to say what it costs "about". */
  price: string | null;
  /** The book's best bid and best ask when the review opened: a buy fills near the ask, a sell near the bid. */
  bid: string | null;
  ask: string | null;
  /** True once the service's numbers moved while the customer was looking: they must confirm the new ones. */
  changed: boolean;
}

/**
 * The review step (UI-SPEC 5.9 item 4): the SERVICE's numbers (fee, protection price) next to the coin amount that will
 * be sent. A confirmation dialog, drawn while there is a review: focus is trapped, Escape closes it, and nothing is sent
 * until "Confirm".
 */
export function BuyReview({
  review,
  market,
  busy,
  message,
  onCancel,
  onConfirm,
}: {
  review: ReviewState | null;
  market: MarketRow;
  busy: boolean;
  message: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = buyCopy.useCopy();
  const buying = review?.draft.side !== 'sell';
  const places = fractionDigits(market.lotSize) ?? 8;
  const protection = review?.preview.protectionPrice ?? null;
  const price = review?.price ?? null;
  // One call feeds the card and this dialog, so every figure here is the card's figure.
  const rows = review
    ? costRows({
        side: review.draft.side,
        base: review.draft.amount,
        price,
        baseAsset: market.base,
        quoteAsset: market.quote,
        preview: review.preview,
      })
    : null;
  const getValue = (rows && formatGet(rows.get, market.base, places, t)) ?? '—';
  const payValue = rows?.estimated == null ? '—' : fmtUsd(rows.estimated);
  const limitValue = rows?.limit == null ? '—' : fmtUsd(rows.limit);
  const spread = review ? spreadOf(review.bid, review.ask) : null;
  const tick = (value: string | null) => (value === null ? '—' : `$${fmtPrice(value, market.tickSize)}`);
  if (!review) return null;
  return (
    <KitDialog
      alert
      title={buying ? t('Review your buy') : t('Review your sell')}
      description={buying ? t('Review hint') : t('Review hint sell')}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <dl className="lt-kv">
        {buying ? (
          <>
            <Row label={t('You pay about')} value={payValue} data-testid="review-pay" />
            <Row label={t('You get about')} value={getValue} data-testid="review-get" strong />
          </>
        ) : (
          <>
            <Row label={t('You sell')} value={`${fmtAmount(review.draft.amount, { places })} ${market.base}`} data-testid="review-pay" />
            <Row label={t('You get about')} value={getValue} data-testid="review-get" strong />
          </>
        )}
        <Row
          label={t('Price')}
          value={price === null ? '—' : t('Price per coin', { price: `$${fmtPrice(price, market.tickSize)}`, coin: market.base })}
        />
        <Row label={t('Best bid')} value={tick(review.bid)} data-testid="review-bid" />
        <Row label={t('Best ask')} value={tick(review.ask)} data-testid="review-ask" />
        <Row
          label={t('Spread')}
          value={
            spread === null
              ? '—'
              : t('Spread value', {
                  width: `$${fmtPrice(spread.width, market.tickSize)}`,
                  share: fmtPct(spread.ratio, { places: 3, signed: false }),
                })
          }
          data-testid="review-spread"
        />
        <div>
          <dt>{t('Fee')}</dt>
          <dd>
            <span data-testid="review-fee">
              {review.preview.estimatedFee === null
                ? '—'
                : `${fmtAmount(review.preview.estimatedFee, { places: 8 })} ${review.preview.feeAsset ?? ''}`.trim()}
            </span>
            {rows?.fee?.usd != null ? (
              <span data-testid="review-fee-usd"> {t('Fee in dollars', { value: fmtUsd(rows.fee.usd) })}</span>
            ) : null}
          </dd>
        </div>
        <Row label={buying ? t('Most you can pay') : t('Least you get')} value={limitValue} data-testid="review-limit" />
        {protection !== null ? (
          <Row
            label={t('Price protection')}
            value={
              buying
                ? t('Protection buy', { price: `$${fmtPrice(protection, market.tickSize)}` })
                : t('Protection sell', { price: `$${fmtPrice(protection, market.tickSize)}` })
            }
            data-testid="review-protection"
          />
        ) : null}
      </dl>
      {review.changed ? (
        <p className="lt-hint" role="status" data-testid="review-changed">
          {t('Price moved')}
        </p>
      ) : null}
      {message ? (
        <p className="lt-refusal" role="alert">
          {message}
        </p>
      ) : null}
      <div className="lt-actions">
        <Button tone="secondary" disabled={busy} onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button tone="primary" disabled={busy} aria-busy={busy || undefined} onClick={onConfirm}>
          {busy ? t('Sending') : buying ? t('Confirm buy') : t('Confirm sell')}
        </Button>
      </div>
    </KitDialog>
  );
}

function Row({ label, value, strong, ...rest }: { label: string; value: string; strong?: boolean; 'data-testid'?: string }) {
  return (
    <div data-total={strong || undefined}>
      <dt>{label}</dt>
      <dd {...rest}>{value}</dd>
    </div>
  );
}
