import type { RfqQuote } from '../rooms/api';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  KeyValue,
  fmtAmount,
  fmtPrice,
} from '../rooms/ui';
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
    { label: t('Pair'), value: pair },
    { label: t('Side'), value: quote.side === 'buy' ? t('Buy') : t('Sell') },
    { label: t('Quantity'), value: `${fmtAmount(quote.qty)} ${quote.baseAsset}` },
    { label: t('Quoted price'), value: `${fmtPrice(quote.quotedPrice, null)} ${quote.quoteAsset}` },
    { label: cost.direction === 'pay' ? t('You pay') : t('You receive'), value },
    {
      label: t('Spread cost'),
      value: cost.spreadCost === null ? null : `${fmtAmount(cost.spreadCost)} ${quote.quoteAsset} (${cost.spreadBps} bps)`,
    },
    { label: t('Fee'), value: t('Fee zero') },
    { label: t('Counterparty'), value: `${quote.counterparty} · ${quote.counterpartyId}` },
    ...(action === 'accept' ? [{ label: t('Firm until'), value: `${expiresText} · ${countdown.text}` }] : []),
  ];
  return (
    <AlertDialog open={action !== null} onOpenChange={(open) => !open && !sending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{action ? t(`Confirm ${action} title`) : ''}</AlertDialogTitle>
          <AlertDialogDescription>{action ? t(`Confirm ${action} body`) : ''}</AlertDialogDescription>
        </AlertDialogHeader>
        <KeyValue density="dense" items={items} />
        {blockedWhy ? (
          <p role="alert" className="m-0 text-sm text-warn">
            {blockedWhy}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="secondary" size={40} />} disabled={sending}>
            {t('Keep as is')}
          </AlertDialogClose>
          <Button variant="primary" size={40} autoFocus loading={sending} disabled={blockedWhy !== null} onClick={onConfirm}>
            {action ? t(`Confirm ${action} button`) : ''}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
