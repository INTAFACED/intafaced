import { useState } from 'react';
import { Button } from '@intafaced/ui';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { PayAmount, PayDetails, PayFailure, PaySection, PayTime, payTimeText } from '../components';
import type { PersonalPayApi } from '../pay-api';
import type { OrderReceipt as Receipt, Trade } from '../schemas';
import { csvCell, downloadText } from '../portal/csv';
import { historyRefusal } from './OrderHistory';
import { orderHistoryCopy } from './order-history-copy';

/** Basis points as a percent, in exact decimal text: 25 → "0.25". */
export function bpsPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const part = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return part ? `${whole}.${part}` : String(whole);
}

/**
 * The receipt of one order. Only a completed order has one; each "Get receipt" spends one download of the owner's
 * daily and per-order quotas, so it is asked for on purpose and never on page load.
 */
export function OrderReceipt({ pay, trade }: { pay: PersonalPayApi; trade: Trade }) {
  const { t, requestedLocale } = orderHistoryCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult<Receipt> | null>(null);
  const completed = trade.status === 'released';
  const get = async () => {
    setBusy(true);
    setResult(null);
    const answer = await pay.receipt(trade.id);
    setBusy(false);
    setResult(answer);
  };
  const time = (iso: string) => payTimeText(iso, requestedLocale) ?? iso;
  const words = result && !result.ok ? historyRefusal(result, t, time) : null;
  return (
    <PaySection title={t('receiptTitle')} description={completed ? t('receiptBody') : undefined}>
      {!completed ? (
        <p className="muted">{t('receiptOnlyCompleted')}</p>
      ) : (
        <Button variant="secondary" onClick={get} disabled={busy}>
          {busy ? t('receiptLoading') : t('receiptAction')}
        </Button>
      )}
      {result === null ? null : result.ok ? (
        <ReceiptView data={result.data} />
      ) : words ? (
        <p className="failure" role="alert">
          {words}
        </p>
      ) : (
        <PayFailure result={result} retry={get} />
      )}
    </PaySection>
  );
}

function ReceiptView({ data }: { data: Receipt }) {
  const { t } = orderHistoryCopy.useCopy();
  const r = data.receipt;
  const rows: [string, string][] = [
    [t('receiptOrder'), r.tradeId],
    [t('receiptOffer'), r.offerId],
    [t('receiptRole'), r.role === 'buyer' ? t('receiptBuyer') : t('receiptSeller')],
    [t('receiptAmount'), `${r.amount} ${r.asset}`],
    [t('receiptPaid'), `${r.fiatAmount} ${r.fiatCurrency}`],
    [t('receiptPrice'), `${r.price} ${r.fiatCurrency}/${r.asset}`],
    [t('receiptFee'), t('receiptFeeBps', { percent: bpsPercent(r.feeBps) })],
    [t('receiptMethod'), r.method],
    [t('receiptOpened'), r.createdAt],
    [t('receiptEscrowed'), r.escrowedAt ?? ''],
    [t('receiptPaidAt'), r.fiatSentAt ?? ''],
    [t('receiptCompleted'), r.resolvedAt ?? ''],
  ];
  const at = (value: string | null) => (value ? <PayTime value={value} /> : '—');
  return (
    <div className="stack" role="status" data-testid="order-receipt">
      <PayDetails
        values={[
          [t('receiptOrder'), <span lang="zxx">{r.tradeId}</span>],
          [t('receiptRole'), r.role === 'buyer' ? t('receiptBuyer') : t('receiptSeller')],
          [t('receiptAmount'), <PayAmount value={r.amount} unit={r.asset} label={t('receiptAmount')} />],
          [t('receiptPaid'), <PayAmount value={r.fiatAmount} unit={r.fiatCurrency} label={t('receiptPaid')} />],
          [t('receiptPrice'), `${displayAmount(r.price)} ${r.fiatCurrency} / ${r.asset}`],
          [t('receiptFee'), t('receiptFeeBps', { percent: bpsPercent(r.feeBps) })],
          [t('receiptMethod'), <span lang="zxx">{r.method}</span>],
          [t('receiptOpened'), at(r.createdAt)],
          [t('receiptEscrowed'), at(r.escrowedAt)],
          [t('receiptPaidAt'), at(r.fiatSentAt)],
          [t('receiptCompleted'), at(r.resolvedAt)],
        ]}
      />
      <p className="muted">{t('receiptRemaining', { daily: String(data.dailyRemaining), trade: String(data.tradeRemaining) })}</p>
      <Button
        variant="secondary"
        onClick={() => downloadText(`p2p-receipt-${r.tradeId}.csv`, rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n')}
      >
        {t('receiptDownload')}
      </Button>
    </div>
  );
}
