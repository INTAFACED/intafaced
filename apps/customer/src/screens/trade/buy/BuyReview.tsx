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
import { dec, fractionDigits, mulDown, str } from './trade-math';

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
  const about = review && price !== null ? aboutValue(review.draft.amount, price) : null;
  // The fee comes out of the coins bought, so say what is left: "about 0.00007992 BTC after the fee" (words only; the order is unchanged).
  const net = review ? afterFee(review.draft.amount, review.preview.estimatedFee, review.preview.feeAsset, market.base) : null;
  const getValue = review
    ? net !== null
      ? t('{amount} {coin} after the fee', { amount: fmtAmount(net, { places: 8 }), coin: market.base })
      : `${fmtAmount(review.draft.amount, { places })} ${market.base}`
    : '';
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
                <Row label={t('You pay about')} value={about === null ? '—' : fmtUsd(about)} data-testid="review-pay" />
                <Row label={t('You get about')} value={getValue} data-testid="review-get" strong />
              </>
            ) : (
              <>
                <Row
                  label={t('You sell')}
                  value={`${fmtAmount(review.draft.amount, { places })} ${market.base}`}
                  data-testid="review-pay"
                />
                <Row label={t('You get about')} value={about === null ? '—' : fmtUsd(about)} data-testid="review-get" strong />
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

/** Coin amount times price, rounded down: what the order is worth at the price it was sized from. */
function aboutValue(base: string, price: string): string | null {
  const amount = dec(base);
  const unit = dec(price);
  return amount === null || unit === null ? null : str(mulDown(amount, unit));
}

/** The coin amount less a fee taken in that same coin; null when the fee is in something else or unknown. */
function afterFee(base: string, fee: string | null, feeAsset: string | null, coin: string): string | null {
  if (fee === null || feeAsset !== coin) return null;
  const amount = dec(base);
  const taken = dec(fee);
  return amount === null || taken === null || taken > amount ? null : str(amount - taken);
}
