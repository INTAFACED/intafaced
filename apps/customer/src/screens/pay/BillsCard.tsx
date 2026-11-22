import { Button, EmptyState, Field } from '@intafaced/ui/lit';
import { personalCopy } from './personal-copy';
import { payCopy } from './copy';
import { Reason, sourceLabel, Steps, useSources } from './journey';

/**
 * Bill pay (/pay/bills). There is no biller network or bill-payment service behind INTAFACED yet, so every control that
 * would need one is off and the reason is on screen. The balances are the customer's real ones.
 */
export function BillsCard() {
  const { t } = personalCopy.useCopy();
  const { sources, state } = useSources();
  return (
    <div className="lt-review" data-testid="bills-card">
      <Reason title={t('billsReasonTitle')}>{t('billsReasonBody')}</Reason>
      <Steps items={[t('stepBiller'), t('stepReference'), t('stepAmount'), t('stepReview'), t('stepStatus')]} />
      <form className="lt-review" noValidate onSubmit={(event) => event.preventDefault()}>
        <fieldset className="lt-region" disabled>
          <div className="lt-review">
            <label className="lt-field">
              <span>{t('billerLabel')}</span>
              <input id="bill-biller" type="search" placeholder={t('billerPlaceholder')} />
            </label>
            <label className="lt-field">
              <span>{t('billReferenceLabel')}</span>
              <input id="bill-reference" type="text" placeholder={t('billReferencePlaceholder')} />
            </label>
            <Field
              label={payCopy.t('Amount')}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              aria-label={payCopy.t('Amount')}
              placeholder="0"
              value=""
              onChange={() => {}}
              disabled
            />
            <label className="lt-field">
              <span>{t('payFrom')}</span>
              <select id="bill-from" defaultValue="">
                {sources.length === 0 ? <option value="">{state === 'loading' ? '…' : t('payFromNone')}</option> : null}
                {sources.map((row) => (
                  <option key={row.id} value={row.id}>
                    {sourceLabel(row)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
        <Button type="submit" tone="primary" size="lg" block disabled data-testid="bills-review">
          {t('billsReviewOff')}
        </Button>
      </form>
      <div className="lt-region">
        <h3>{t('billsStatus')}</h3>
        <Steps items={[t('statusSubmitted'), t('statusAccepted'), t('statusPaid')]} />
      </div>
      <div className="lt-region">
        <div className="lt-review">
          <h3>{t('billsHistory')}</h3>
          <EmptyState title={t('billsHistoryEmpty')} />
          <h3>{t('billsRecurring')}</h3>
          <EmptyState title={t('billsRecurringEmpty')} />
        </div>
      </div>
    </div>
  );
}
