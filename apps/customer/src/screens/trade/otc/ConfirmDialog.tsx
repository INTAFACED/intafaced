import type { RfqQuote } from '../rooms/api';
import { Button } from '@intafaced/ui/lit';
import { KeyValue, Sheet } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtPrice } from '../rooms/ui';
import { kvRow } from '../options/notices';
import { otcCopy } from './copy';
import { costOf, type Countdown } from './model';

export type Confirming = 'accept' | 'settle' | 'expire';

/**
 * The last look before money moves. It repeats the numbers the person is about to be held to: size, price, the value
 * including the spread, the spread cost, the fee, the counterparty and, for accept, how long the quote stays firm.
 */
export function ConfirmDialog({
  action,
  quote,
  countdown,
  expiresText,
  sending,
  blockedWhy,
  onConfirm,
  onClose,
}: {
  action: Confirming | null;
  quote: RfqQuote;
  countdown: Countdown;
  expiresText: string;
  sending: boolean;
  /** Why Confirm is off right now, or null. */
  blockedWhy: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = otcCopy.useCopy();
  const cost = costOf(quote);
  const pair = `${quote.baseAsset}/${quote.quoteAsset}`;
  const value = cost.value === null ? null : `${fmtAmount(cost.value)} ${quote.quoteAsset}`;
  const items = [
    kvRow(t('Pair'), pair),
    kvRow(t('Side'), quote.side === 'buy' ? t('Buy') : t('Sell')),
    kvRow(t('Quantity'), `${fmtAmount(quote.qty)} ${quote.baseAsset}`),
    kvRow(t('Quoted price'), `${fmtPrice(quote.quotedPrice, null)} ${quote.quoteAsset}`),
    kvRow(cost.direction === 'pay' ? t('You pay') : t('You receive'), value),
    kvRow(t('Spread cost'), cost.spreadCost === null ? null : `${fmtAmount(cost.spreadCost)} ${quote.quoteAsset} (${cost.spreadBps} bps)`),
    kvRow(t('Fee'), t('Fee zero')),
    kvRow(t('Counterparty'), `${quote.counterparty} · ${quote.counterpartyId}`),
    ...(action === 'accept' ? [kvRow(t('Firm until'), `${expiresText} · ${countdown.text}`)] : []),
  ];
  return (
    <Sheet
      role="alertdialog"
      open={action !== null}
      onClose={() => !sending && onClose()}
      title={action ? t(`Confirm ${action} title`) : ''}
      description={action ? t(`Confirm ${action} body`) : undefined}
    >
      {action === null ? null : (
        <>
          <KeyValue rows={items} />
          {blockedWhy ? (
            <p role="alert" className="lt-alert">
              {blockedWhy}
            </p>
          ) : null}
          <div className="lt-actions">
            <Button size="lg" disabled={sending} onClick={onClose}>
              {t('Keep as is')}
            </Button>
            <Button
              size="lg"
              tone="primary"
              data-autofocus=""
              aria-busy={sending || undefined}
              disabled={blockedWhy !== null || sending}
              onClick={onConfirm}
            >
              {action ? t(`Confirm ${action} button`) : ''}
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}
