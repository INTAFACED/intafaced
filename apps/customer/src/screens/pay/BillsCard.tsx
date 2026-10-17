import { AmountInput, Button } from './deps';
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
    <div className="pay-body" data-testid="bills-card">
      <Reason title={t('billsReasonTitle')}>{t('billsReasonBody')}</Reason>
      <Steps items={[t('stepBiller'), t('stepReference'), t('stepAmount'), t('stepReview'), t('stepStatus')]} />
      <form className="pay-body" noValidate onSubmit={(event) => event.preventDefault()}>
        <fieldset className="pay-fieldset" disabled>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="bill-biller">
              {t('billerLabel')}
            </label>
            <input id="bill-biller" className="pay-text" type="search" placeholder={t('billerPlaceholder')} />
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="bill-reference">
              {t('billReferenceLabel')}
            </label>
            <input id="bill-reference" className="pay-text" type="text" placeholder={t('billReferencePlaceholder')} />
          </div>
          <div className="pay-field">
            <span className="pay-field__label">{payCopy.t('Amount')}</span>
            <AmountInput aria-label={payCopy.t('Amount')} value="" onValueChange={() => {}} precision={18} placeholder="0" disabled />
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="bill-from">
              {t('payFrom')}
            </label>
            <select id="bill-from" className="pay-text" defaultValue="">
              {sources.length === 0 ? <option value="">{state === 'loading' ? '…' : t('payFromNone')}</option> : null}
              {sources.map((row) => (
                <option key={row.id} value={row.id}>
                  {sourceLabel(row)}
                </option>
              ))}
            </select>
          </div>
        </fieldset>
        <Button type="submit" variant="primary" size={56} fullWidth disabled data-testid="bills-review">
          {t('billsReviewOff')}
        </Button>
      </form>
      <div className="pay-block">
        <h3 className="pay-section-title">{t('billsStatus')}</h3>
        <Steps items={[t('statusSubmitted'), t('statusAccepted'), t('statusPaid')]} />
      </div>
      <div className="pay-block">
        <h3 className="pay-section-title">{t('billsHistory')}</h3>
        <p className="pay-empty">{t('billsHistoryEmpty')}</p>
        <h3 className="pay-section-title">{t('billsRecurring')}</h3>
        <p className="pay-empty">{t('billsRecurringEmpty')}</p>
      </div>
    </div>
  );
}
