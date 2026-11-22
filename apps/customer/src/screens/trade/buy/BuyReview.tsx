import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  fmtAmount,
  fmtPrice,
  fmtUsd,
  type Draft,
  type MarketRow,
  type Preview,
} from './deps';
import { buyCopy } from './copy';
import { costRows } from './cost';
import { formatGet } from './cost-format';
import { fractionDigits } from './trade-math';

export interface ReviewState {
  draft: Draft;
  preview: Preview;
  /** The price the order was sized from, to say what it costs "about". */
  price: string | null;
  /** True once the service's numbers moved while the customer was looking: they must confirm the new ones. */
  changed: boolean;
}

/**
 * The review step (UI-SPEC 5.9 item 4): the SERVICE's numbers (fee, protection price) next to the coin amount that will
 * be sent. A confirmation dialog: focus is trapped, Escape closes it, and nothing is sent until "Confirm".
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
  return (
    <AlertDialog
      open={review !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogContent className="buy-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{buying ? t('Review your buy') : t('Review your sell')}</AlertDialogTitle>
          <AlertDialogDescription>{buying ? t('Review hint') : t('Review hint sell')}</AlertDialogDescription>
        </AlertDialogHeader>
        {review ? (
          <dl className="buy-dialog__rows">
            {buying ? (
              <>
                <Row label={t('You pay about')} value={payValue} data-testid="review-pay" />
                <Row label={t('You get about')} value={getValue} data-testid="review-get" strong />
              </>
            ) : (
              <>
                <Row
                  label={t('You sell')}
                  value={`${fmtAmount(review.draft.amount, { places })} ${market.base}`}
                  data-testid="review-pay"
                />
                <Row label={t('You get about')} value={getValue} data-testid="review-get" strong />
              </>
            )}
            <Row
              label={t('Price')}
              value={price === null ? '—' : t('Price per coin', { price: `$${fmtPrice(price, market.tickSize)}`, coin: market.base })}
            />
            <Row
              label={t('Fee')}
              value={
                review.preview.estimatedFee === null
                  ? '—'
                  : `${fmtAmount(review.preview.estimatedFee, { places: 8 })} ${review.preview.feeAsset ?? ''}`.trim()
              }
              data-testid="review-fee"
            />
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
        ) : null}
        {review?.changed ? (
          <p className="buy-dialog__note" role="status" data-testid="review-changed">
            {t('Price moved')}
          </p>
        ) : null}
        {message ? (
          <p className="buy-dialog__error" role="alert">
            {message}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="secondary" size={40} />} disabled={busy}>
            {t('Cancel')}
          </AlertDialogClose>
          <Button variant={buying ? 'buy' : 'sell'} size={40} loading={busy} onClick={onConfirm}>
            {busy ? t('Sending') : buying ? t('Confirm buy') : t('Confirm sell')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Row({ label, value, strong, ...rest }: { label: string; value: string; strong?: boolean; 'data-testid'?: string }) {
  return (
    <div className="buy-dialog__row" data-strong={strong || undefined}>
      <dt>{label}</dt>
      <dd {...rest}>{value}</dd>
    </div>
  );
}
