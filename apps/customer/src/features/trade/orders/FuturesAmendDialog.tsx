import { useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  KeyValue,
} from '@intafaced/ui';
import { fmtAmount, fmtPrice } from '../../../data/format';
import type { FuturesOrder, FuturesReplace } from '../../../screens/trade/futures/api';
import { useFuturesApi } from '../../../screens/trade/futures/data';
import { futuresRefusal } from '../../../screens/trade/futures/refusals';
import { futuresOrdersCopy } from './futures-orders-copy';

/** A futures order the room offers to amend: the trader's own resting limit order, with nothing filled. */
export function amendable(order: FuturesOrder): boolean {
  return order.status === 'open' && (order.origin ?? 'user') === 'user' && order.type === 'limit' && !/[1-9]/.test(order.filledQty);
}

const positive = (raw: string) => /^\d+(\.\d+)?$/.test(raw.trim()) && /[1-9]/.test(raw);
/** The same decimal written two ways ('65000' and '65000.00000000'): trailing zeros only after the point. */
const norm = (raw: string) => {
  const [whole = '', fraction = ''] = raw.trim().split('.');
  const f = fraction.replace(/0+$/, '');
  return `${whole.replace(/^0+(?=\d)/, '')}${f ? `.${f}` : ''}`;
};
const same = (a: string, b: string) => norm(a) === norm(b);

/**
 * Amend a resting futures order (J-derivatives-04 step 3). The book can't amend a futures order in place, so this is a
 * reviewed cancel-and-replace: the trader sets a new price or size, reviews what will happen, and only Confirm changes
 * anything. The replacement keeps the order's side, leverage and label, and goes to the back of the queue.
 */
export function FuturesAmendDialog({
  order,
  onClose,
  onDone,
}: {
  order: FuturesOrder;
  onClose: () => void;
  onDone: (answer: FuturesReplace) => void;
}) {
  const { t } = futuresOrdersCopy.useCopy();
  const api = useFuturesApi();
  const [price, setPrice] = useState(order.limitPrice);
  const [size, setSize] = useState(order.qty);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // A size that moves the position into a higher margin tier is refused until the trader accepts that tier.
  const [tierAsked, setTierAsked] = useState<number | null>(null);
  const [tierAccepted, setTierAccepted] = useState(false);

  const priceOk = positive(price);
  const sizeOk = positive(size);
  const changed = !same(price, order.limitPrice) || !same(size, order.qty);

  async function confirm() {
    setBusy(true);
    setRefusal(null);
    const result = await api.amendOrder(order.orderId, {
      ...(!same(price, order.limitPrice) ? { price: price.trim() } : {}),
      ...(!same(size, order.qty) ? { amount: size.trim() } : {}),
      ...(tierAsked !== null && tierAccepted ? { confirmTier: tierAsked } : {}),
    });
    setBusy(false);
    if (result.ok) {
      onDone(result.data);
      return;
    }
    const tier = result.code === 'trade.risk_limit_confirm_required' ? /confirmTier (\d+)/.exec(result.message)?.[1] : undefined;
    if (tier) {
      setTierAsked(Number(tier));
      setTierAccepted(false);
    }
    const words = futuresRefusal(result);
    setRefusal(`${words.title}. ${words.body}`);
    // A refusal before the cancel changed nothing: back to the figures. One after it is kept on screen as it stands.
    if (result.code !== 'trade.futures_amend_replacement_refused') setReviewing(Boolean(tier));
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={t('amendClose')}>
        <DialogHeader>
          <DialogTitle>{t('amendTitle', { symbol: order.symbol ?? order.marketId })}</DialogTitle>
          <DialogDescription>{t('amendLead')}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex flex-col gap-3 text-sm">
          {reviewing ? (
            <section aria-label={t('amendReview')} className="flex flex-col gap-2">
              <KeyValue
                items={[
                  {
                    label: t('amendPrice'),
                    value: t('amendFromTo', { from: fmtPrice(order.limitPrice, undefined), to: fmtPrice(price.trim(), undefined) }),
                  },
                  {
                    label: t('amendSize'),
                    value: t('amendFromTo', { from: fmtAmount(order.qty, { places: 8 }), to: fmtAmount(size.trim(), { places: 8 }) }),
                  },
                ]}
              />
              <p role="note">{t('amendHow')}</p>
              {tierAsked !== null ? (
                <label className="flex items-center gap-2">
                  <Checkbox checked={tierAccepted} onCheckedChange={(on) => setTierAccepted(on === true)} />
                  <span>{t('amendTier', { tier: String(tierAsked) })}</span>
                </label>
              ) : null}
            </section>
          ) : (
            <>
              <Field label={t('amendPrice')} error={price !== '' && !priceOk ? t('amendBadNumber') : undefined}>
                <Input kind="decimal" value={price} onValueChange={setPrice} precision={8} />
              </Field>
              <Field label={t('amendSize')} error={size !== '' && !sizeOk ? t('amendBadNumber') : undefined}>
                <Input kind="decimal" value={size} onValueChange={setSize} precision={8} />
              </Field>
            </>
          )}
          {refusal ? (
            <p role="alert" className="orders-note orders-note--bad">
              {t('amendRefused', { reason: refusal })}
            </p>
          ) : null}
        </div>
        <DialogFooter className="mt-5">
          {reviewing ? (
            <>
              <Button variant="secondary" size={40} onClick={() => setReviewing(false)} disabled={busy}>
                {t('amendBack')}
              </Button>
              <Button
                variant="primary"
                size={40}
                loading={busy}
                disabled={tierAsked !== null && !tierAccepted}
                onClick={() => void confirm()}
              >
                {t('amendConfirm')}
              </Button>
            </>
          ) : (
            <Button variant="primary" size={40} disabled={!priceOk || !sizeOk || !changed} onClick={() => setReviewing(true)}>
              {t('amendReviewButton')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
