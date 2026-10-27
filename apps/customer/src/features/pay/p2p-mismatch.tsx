import { useEffect, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { displayAmount } from '../../shared/money';
import { PayFailure } from './components';
import { Button } from '@intafaced/ui';
import type { PersonalPayApi } from './pay-api';
import { mismatchCopy } from './p2p-mismatch-copy';
import type { Trade, TradeMismatch } from './schemas';
import { Field } from './ui-kit';

const KINDS = ['under', 'over', 'partial'] as const;

/**
 * P-trade-orders-20 / J-p2p-02 #3: the seller of a paid order reports that the money in their own bank is not the
 * order's amount. svc-p2p classifies it by the owner's band; the order stays paid either way, and the dispute section
 * of this page is the way on when it is outside the band or no band is set.
 */
export function ReportMismatch({ trade, pay, onReported }: { trade: Trade; pay: PersonalPayApi; onReported: () => void }) {
  const { t } = mismatchCopy.useCopy();
  const [kind, setKind] = useState<TradeMismatch['kind']>('under');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [answered, setAnswered] = useState<TradeMismatch | null>(null);
  useEffect(() => setAnswered(null), [trade.id, trade.mismatch]);
  const report = answered ?? trade.mismatch ?? null;
  if (report) return <MismatchResult report={report} currency={trade.fiatCurrency} />;
  // A decimal comma reads as the point svc-p2p takes; anything else that is not a plain decimal is refused here.
  const typed = amount.replace(',', '.');
  const wellFormed = /^\d+(\.\d+)?$/.test(typed);
  const refusal =
    failure?.code === 'p2p.mismatch_report_exists' ? t('exists') : failure?.code === 'p2p.invalid_amount' ? t('invalid') : null;
  return (
    <details className="p2p-order-other" data-testid="order-mismatch">
      <summary>{t('title')}</summary>
      <p className="muted">{t('why')}</p>
      <fieldset>
        <legend>{t('kind')}</legend>
        {KINDS.map((option) => (
          <label key={option}>
            <input type="radio" name={`mismatch-${trade.id}`} checked={kind === option} onChange={() => setKind(option)} />
            <span>{t(option)}</span>
          </label>
        ))}
      </fieldset>
      <Field
        label={t('amount', { currency: trade.fiatCurrency })}
        hint={t('expected', { amount: displayAmount(trade.fiatAmount), currency: trade.fiatCurrency })}
        inputMode="decimal"
        value={amount}
        onChange={(event) => setAmount(event.target.value.trim())}
      />
      <Button
        variant="secondary"
        disabled={sending || !wellFormed}
        onClick={async () => {
          setSending(true);
          setFailure(null);
          const result = await pay.reportMismatch(trade.id, kind, typed);
          setSending(false);
          if (!result.ok) {
            setFailure(result);
            // Another tab or an earlier press already reported: read the order again so its report shows.
            if (result.code === 'p2p.mismatch_report_exists') onReported();
            return;
          }
          setAnswered(result.data);
          onReported();
        }}
      >
        {t('report')}
      </Button>
      {amount === '' ? <p className="muted">{t('amountMissing')}</p> : !wellFormed ? <p className="muted">{t('format')}</p> : null}
      {refusal ? (
        <p data-testid="failure" className="failure" role="status">
          {refusal}
        </p>
      ) : failure ? (
        <PayFailure result={failure} />
      ) : null}
    </details>
  );
}

/** The report and what it means for the seller, in the words of its classification. */
function MismatchResult({ report, currency }: { report: TradeMismatch; currency: string }) {
  const { t } = mismatchCopy.useCopy();
  return (
    <div className="stack" role="status" data-testid="order-mismatch-result">
      <p>{t('reported', { amount: displayAmount(report.amountReceived), expected: displayAmount(report.expected), currency })}</p>
      <p className="muted">
        {report.classification === 'within_tolerance'
          ? t('within')
          : report.classification === 'outside_tolerance'
            ? t('outside')
            : t('personDecides')}
      </p>
    </div>
  );
}

/** The buyer's side: the seller's amount report on a paid order, and what it means for the buyer. */
export function BuyerMismatch({ trade }: { trade: Trade }) {
  const { t } = mismatchCopy.useCopy();
  const report = trade.mismatch;
  if (!report) return null;
  const currency = trade.fiatCurrency;
  return (
    <div className="stack" role="status" data-testid="order-mismatch-seen">
      <p>{t('buyerReported', { amount: displayAmount(report.amountReceived), expected: displayAmount(report.expected), currency })}</p>
      <p className="muted">
        {report.classification === 'within_tolerance'
          ? t('buyerWithin')
          : report.classification === 'outside_tolerance'
            ? t('buyerOutside')
            : t('buyerPersonDecides')}
      </p>
    </div>
  );
}
