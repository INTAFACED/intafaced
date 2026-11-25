import { useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import type { BusinessPayApi } from '../pay-api';
import type { PortalApi } from '../portal/api';
import { extensionCopy } from '../portal/extension-copy';
import { DEFAULT_ASSET, useAssetChoices } from '../portal/payments/asset-choices';
import { DateTime } from '../portal/ui/DateTime';
import { useUnsavedForm } from '../portal/useUnsavedForm';
import { SelectField } from '../portal/volt/parts';
import { PayCopy, payCopy } from '../copy';
import { cadenceWord, mandateFormDirty, submitCreateMandate } from '../MerchantBilling';
import { PayDetails, PaySection, ReviewedAction } from './parts';

/** A time picked in a datetime-local field, shown the way every other date in the portal is. */
function localTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? <DateTime value={date.toISOString()} /> : value;
}

/** Record an existing customer mandate on the Volt kit; shared by `/pay/subscriptions/new` and `MerchantBilling`. */
export function CreateMandate({ pay, refresh, portal }: { pay: BusinessPayApi; refresh: () => void; portal?: PortalApi }) {
  const [expanded, setExpanded] = useState(false);
  const [customer, setCustomer] = useState('');
  const [asset, setAsset] = useState(DEFAULT_ASSET);
  const assets = useAssetChoices(portal, pay.authority?.merchantId, asset);
  const [amount, setAmount] = useState('');
  const [ceiling, setCeiling] = useState('');
  const [cadence, setCadence] = useState('monthly');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [rail, setRail] = useState('');
  const [reference, setReference] = useState('');
  const [created, setCreated] = useState('');
  useUnsavedForm(
    expanded && mandateFormDirty({ customer, asset, amount, ceiling, starts, ends, rail, reference }),
    extensionCopy.t('draftWarning'),
  );
  return (
    <PaySection
      title={payCopy.t('recordACustomerMandate')}
      description={payCopy.t('recordExistingCustomerAuthorizationThisFormDoes')}
      action={
        <Button tone="secondary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? payCopy.t('hideForm') : payCopy.t('newMandate')}
        </Button>
      }
    >
      {expanded && (
        <div className="lt-stack">
          <Field
            label={payCopy.t('authorizedCustomerId')}
            value={customer}
            onChange={(event) => setCustomer(event.target.value)}
            maxLength={128}
          />
          <div className="lt-field-row">
            <Field
              label={payCopy.t('authorizedAmount')}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <SelectField label={payCopy.t('asset')} value={asset} onChange={setAsset} options={assets.map((a) => [a, a] as const)} />
          </div>
          <Field
            label={payCopy.t('authorizedCeilingOptional')}
            inputMode="decimal"
            value={ceiling}
            onChange={(event) => setCeiling(event.target.value)}
          />
          <SelectField
            label={payCopy.t('cadence')}
            value={cadence}
            onChange={setCadence}
            options={[
              ['daily', payCopy.t('daily')],
              ['weekly', payCopy.t('weekly')],
              ['monthly', payCopy.t('monthly')],
            ]}
          />
          <div className="lt-field-row">
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
          </div>
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
          <ReviewedAction
            title={payCopy.t('recordMandate')}
            description={payCopy.t('storeTheSuppliedAuthorizedTermsChangingAmount')}
            review={
              <PayDetails
                values={[
                  [payCopy.t('customer'), customer],
                  [payCopy.t('amountCeiling'), `${amount} / ${ceiling || payCopy.t('notSupplied')} ${asset}`],
                  [payCopy.t('cadence'), cadenceWord(cadence)],
                  [
                    payCopy.t('authorizationWindow'),
                    <>
                      {localTime(starts)} → {ends ? localTime(ends) : payCopy.t('openEnded')}
                    </>,
                  ],
                ]}
              />
            }
            perform={() => submitCreateMandate(pay, { customer, asset, amount, ceiling, cadence, starts, ends, rail, reference })}
            disabled={!customer || !amount || !asset || !starts || Boolean(pay.access('pay:write'))}
            onConfirmed={(data) => {
              setCreated(data.id);
              setCustomer('');
              setAsset(DEFAULT_ASSET);
              setAmount('');
              setCeiling('');
              setStarts('');
              setEnds('');
              setRail('');
              setReference('');
              refresh();
              setExpanded(false);
            }}
          />
        </div>
      )}
      {created && (
        <p className="lt-note-good" role="status">
          <PayCopy k="mandateRecorded" />
        </p>
      )}
    </PaySection>
  );
}
