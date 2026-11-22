import { Button, Field, Select } from '@intafaced/ui/lit';
import type { PortalApi } from '../portal/api';
import type { BusinessPayApi } from '../pay-api';
import { payCopy } from '../copy';
import { cadenceWord } from '../MerchantBilling';
import { useMandateForm } from '../mandate-form';
import { ReviewedAction } from '../review/ReviewedAction';
import { Details } from '../p2p-flow/parts';
import { Actions, DateTime, Section, SelectField } from '../portal/flow/parts';

/** A time picked in a datetime-local field, shown the way every other date in the portal is. */
function localTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? <DateTime value={date.toISOString()} /> : value;
}

/**
 * "Record a customer mandate", drawn from the kit: `MerchantBilling.tsx`'s `CreateMandate` over the same state and call
 * (`useMandateForm`), with the same fields, words and review. The merchant portal's flow rooms draw this one.
 */
export function CreateMandate({ pay, refresh, portal }: { pay: BusinessPayApi; refresh: () => void; portal?: PortalApi }) {
  const {
    expanded,
    setExpanded,
    customer,
    setCustomer,
    asset,
    setAsset,
    assets,
    amount,
    setAmount,
    ceiling,
    setCeiling,
    cadence,
    setCadence,
    starts,
    setStarts,
    ends,
    setEnds,
    rail,
    setRail,
    reference,
    setReference,
    created,
    perform,
    disabled,
    onConfirmed,
  } = useMandateForm({ pay, refresh, portal });
  return (
    <Section
      title={payCopy.t('recordACustomerMandate')}
      description={payCopy.t('recordExistingCustomerAuthorizationThisFormDoes')}
      action={
        <Button tone="secondary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? payCopy.t('hideForm') : payCopy.t('newMandate')}
        </Button>
      }
    >
      {expanded && (
        <div>
          <Field
            label={payCopy.t('authorizedCustomerId')}
            value={customer}
            onChange={(event) => setCustomer(event.target.value)}
            maxLength={128}
          />
          <Field
            label={payCopy.t('authorizedAmount')}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <SelectField label={payCopy.t('asset')} value={asset} onChange={setAsset} options={assets.map((a) => [a, a] as const)} />
          <Field
            label={payCopy.t('authorizedCeilingOptional')}
            inputMode="decimal"
            value={ceiling}
            onChange={(event) => setCeiling(event.target.value)}
          />
          <Select
            label={payCopy.t('cadence')}
            value={cadence}
            onChange={setCadence}
            options={[
              ['daily', payCopy.t('daily')],
              ['weekly', payCopy.t('weekly')],
              ['monthly', payCopy.t('monthly')],
            ]}
          />
          <Field
            label={payCopy.t('authorizationStarts')}
            type="datetime-local"
            value={starts}
            onChange={(event) => setStarts(event.target.value)}
          />
          <Field
            label={payCopy.t('authorizationEndsOptional')}
            type="datetime-local"
            value={ends}
            onChange={(event) => setEnds(event.target.value)}
          />
          <Field
            label={payCopy.t('existingMandateRailOptional')}
            value={rail}
            onChange={(event) => setRail(event.target.value)}
            maxLength={64}
          />
          <Field
            label={payCopy.t('existingRailMandateReferenceOptional')}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            maxLength={256}
          />
          <Actions>
            <ReviewedAction
              title={payCopy.t('recordMandate')}
              description={payCopy.t('storeTheSuppliedAuthorizedTermsChangingAmount')}
              review={
                <Details
                  values={[
                    [payCopy.t('customer'), customer],
                    [payCopy.t('amountCeiling'), `${amount} / ${ceiling || payCopy.t('notSupplied')} ${asset}`],
                    [payCopy.t('cadence'), cadenceWord(cadence)],
                    [
                      payCopy.t('authorizationWindow'),
                      <>
                        {localTime(starts)} – {ends ? localTime(ends) : payCopy.t('openEnded')}
                      </>,
                    ],
                  ]}
                />
              }
              perform={perform}
              disabled={disabled}
              onConfirmed={onConfirmed}
            />
          </Actions>
        </div>
      )}
      {created && (
        <p role="status">
          <payCopy.Copy k="mandateRecorded" />
        </p>
      )}
    </Section>
  );
}
