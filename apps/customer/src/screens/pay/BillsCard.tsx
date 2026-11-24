import { AmountField, Button, EmptyState, Field } from '@intafaced/ui/lit';
import { SelectField } from '@intafaced/ui/lit/templates';
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
    <div className="lt-stack" data-testid="bills-card">
      <Reason title={t('billsReasonTitle')}>{t('billsReasonBody')}</Reason>
      <Steps items={[t('stepBiller'), t('stepReference'), t('stepAmount'), t('stepReview'), t('stepStatus')]} />
      <form className="lt-stack" noValidate onSubmit={(event) => event.preventDefault()}>
        <fieldset className="lt-stack" disabled>
          <Field id="bill-biller" label={t('billerLabel')} type="search" placeholder={t('billerPlaceholder')} />
          <Field id="bill-reference" label={t('billReferenceLabel')} type="text" placeholder={t('billReferencePlaceholder')} />
          <AmountField label={payCopy.t('Amount')} value="" onChange={() => {}} precision={18} placeholder="0" disabled />
          <SelectField
            id="bill-from"
            label={t('payFrom')}
            value=""
            onChange={() => {}}
            options={
              sources.length === 0
                ? [{ value: '', label: state === 'loading' ? '…' : t('payFromNone') }]
                : sources.map((row) => ({ value: row.id, label: sourceLabel(row) }))
            }
          />
        </fieldset>
        <Button type="submit" tone="primary" size="lg" block disabled data-testid="bills-review">
          {t('billsReviewOff')}
        </Button>
      </form>
      <div className="lt-stack">
        <h3>{t('billsStatus')}</h3>
        <Steps items={[t('statusSubmitted'), t('statusAccepted'), t('statusPaid')]} />
      </div>
      <div className="lt-stack">
        <h3>{t('billsHistory')}</h3>
        <EmptyState title={t('billsHistoryEmpty')} />
        <h3>{t('billsRecurring')}</h3>
        <EmptyState title={t('billsRecurringEmpty')} />
      </div>
    </div>
  );
}
