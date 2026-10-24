import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, DataTable, ReviewDialog as Dialog } from '@intafaced/ui';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { uiCopy } from '../../../shared/ui-copy';
import { PayFailure, PayNotice, PayPagination, PaySection, PayState, ReviewedAction, Status } from '../components';
import { payCopy } from '../copy';
import type { PersonalPayApi } from '../pay-api';
import type { MethodField } from '../schemas';
import { methodsCopy } from './payment-methods-copy';

type Method = { methodId: string; country: string; label: string; fields: MethodField[]; enabled: boolean; settlement?: Settlement };
type Settlement = { instant: true } | { instant: false; windowSeconds: number | null };
type MethodsT = ReturnType<typeof methodsCopy.useCopy>['t'];

const EVERYWHERE = '*';

/**
 * P2P payment methods (P-ads-merchant-18, -19; J-p2p-04): what each method asks for per country, adding one in the
 * person's own name, and the ones they hold. Saved values never come back here: the list shows the person's own labels,
 * and a buyer sees the details only on an order placed with them.
 */
export function PaymentMethods({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const { t } = methodsCopy.useCopy();
  const health = useResource((signal) => pay.health(signal), 'pay:p2p-health');
  const catalogue = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  const [limit, setLimit] = useState(50);
  const instruments = useResource((signal) => pay.instruments(limit, signal), `pay:instruments:${userId}:${limit}`);
  // Saving needs a key service that protects the details: while its state is unknown the form stays shut too.
  const keyOn = health.resource.status === 'ready' && health.resource.data.instrumentKeyProvider === 'local-test';
  const keyOff = health.resource.status === 'ready' && !keyOn;
  return (
    <div className="stack" data-testid="payment-methods">
      {keyOff ? (
        <div data-testid="methods-key-off">
          <PayNotice title={t('keyOffTitle')}>{t('keyOff')}</PayNotice>
        </div>
      ) : null}
      <PaySection title={t('catalogueTitle')} description={t('catalogueIntro')}>
        <MethodsState resource={catalogue.resource} retry={catalogue.reload}>
          {(methods) => <Catalogue methods={methods} />}
        </MethodsState>
      </PaySection>
      <PaySection title={t('addTitle')} description={t('addIntro')}>
        <MethodsState resource={catalogue.resource} retry={catalogue.reload}>
          {(methods) => (
            <AddMethod pay={pay} methods={methods.filter((method) => method.enabled)} disabled={!keyOn} onSaved={instruments.reload} />
          )}
        </MethodsState>
      </PaySection>
      <PaySection title={payCopy.t('yourPaymentDestinationLabels')}>
        <PayState resource={instruments.resource} retry={instruments.reload} empty={payCopy.t('noPaymentDestinationHeadersReturned')}>
          {(rows) => (
            <>
              <DataTable
                label={payCopy.t('paymentDestinations')}
                headers={[payCopy.t('label'), payCopy.t('method'), payCopy.t('currencyCountry'), payCopy.t('state'), '']}
              >
                {rows.map((instrument) => (
                  <tr key={instrument.id} data-testid="saved-method">
                    <td>{instrument.label || payCopy.t('unlabelledDestination')}</td>
                    <td>{instrument.methodId}</td>
                    <td>
                      {instrument.fiatCurrency} / {instrument.country}
                    </td>
                    <td>
                      <Status value={instrument.status} />
                    </td>
                    <td>
                      {instrument.status === 'active' && (
                        <ReviewedAction
                          title={payCopy.t('removeDestination')}
                          description={payCopy.t('thisRemovesTheDestinationFromFutureTrades')}
                          perform={() => pay.removeInstrument(instrument.id)}
                          onConfirmed={instruments.reload}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
            </>
          )}
        </PayState>
      </PaySection>
    </div>
  );
}

/** The registry ships empty: that is a plain sentence, not a failure (svc-p2p refuses `p2p.instrument_method_unknown`). */
function MethodsState({
  resource,
  retry,
  children,
}: {
  resource: ReturnType<typeof useResource<Method[]>>['resource'];
  retry: () => void;
  children: (methods: Method[]) => ReactNode;
}) {
  const { t } = methodsCopy.useCopy();
  if (resource.status === 'failed' && resource.failure.code === 'p2p.instrument_method_unknown')
    return <p className="muted">{t('catalogueUnset')}</p>;
  return (
    <PayState resource={resource} retry={retry}>
      {(methods) => (methods.length === 0 ? <p className="muted">{t('catalogueUnset')}</p> : children(methods))}
    </PayState>
  );
}

/**
 * The methods a person in `country` can use: each method once, by the row for that country where there is one, else
 * the every-country row. svc-p2p validates a save against that same row.
 */
function methodsIn(methods: Method[], country: string): Method[] {
  const exact = new Set(methods.filter((method) => method.country === country).map((method) => method.methodId));
  return methods.filter((method) => method.country === country || (method.country === EVERYWHERE && !exact.has(method.methodId)));
}

function countryName(code: string, everywhere: string): string {
  return code === EVERYWHERE ? everywhere : code;
}

function Catalogue({ methods }: { methods: Method[] }) {
  const { t } = methodsCopy.useCopy();
  const countries = useMemo(() => [...new Set(methods.map((method) => method.country))].sort(), [methods]);
  // A real country first: methods registered for every country show under each one too.
  const [country, setCountry] = useState(countries.find((code) => code !== EVERYWHERE) ?? countries[0] ?? '');
  const shown = country === EVERYWHERE ? methods.filter((method) => method.country === EVERYWHERE) : methodsIn(methods, country);
  return (
    <div className="form-stack" data-testid="methods-catalogue">
      <label className="field">
        <span>{t('catalogueCountry')}</span>
        <select value={country} onChange={(event) => setCountry(event.target.value)}>
          {countries.map((code) => (
            <option key={code} value={code}>
              {countryName(code, t('catalogueEverywhere'))}
            </option>
          ))}
        </select>
      </label>
      {shown.map((method) => (
        <article
          key={`${method.methodId}:${method.country}`}
          className="pay-destination"
          data-testid="catalogue-method"
          data-method={method.methodId}
          data-country={method.country}
        >
          <div className="stack">
            <strong>{method.label}</strong>
            <small className="muted">{countryName(method.country, t('catalogueEverywhere'))}</small>
            {method.settlement ? <p className="muted">{settlementText(method.settlement, t)}</p> : null}
            <p>{t('catalogueAsks')}:</p>
            <ul>
              {method.fields.map((field) => (
                <li key={field.key}>
                  {field.label} ({t(field.required ? 'catalogueRequired' : 'catalogueOptional')}){field.help ? `: ${field.help}` : ''}
                </li>
              ))}
            </ul>
            {method.fields.some((field) => field.holderName) ? <p data-testid="catalogue-own-name">{t('catalogueOwnName')}</p> : null}
          </div>
          <Status value={method.enabled ? 'enabled' : 'disabled'} />
        </article>
      ))}
    </div>
  );
}

/** The registry's settlement profile in words, to the minute: a method without one says nothing about speed. */
function settlementText(settlement: Settlement, t: MethodsT) {
  if (settlement.instant) return t('catalogueInstant');
  if (settlement.windowSeconds === null) return t('catalogueWindowDefault');
  const minutes = Math.ceil(settlement.windowSeconds / 60);
  if (minutes < 60) return t('catalogueWindowMinutes', { minutes: String(minutes) });
  if (minutes % 60 === 0) return t('catalogueWindow', { hours: String(minutes / 60) });
  return t('catalogueWindowHoursMinutes', { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) });
}

type Refusal = { field: string | null; text: string };

/** What a refused save says, and on which field, from svc-p2p's code (the service's prose is not shown). */
function refusalOf(result: Extract<ApiResult<unknown>, { ok: false }>, method: Method | undefined, t: MethodsT): Refusal | null {
  const field = result.p2pLimit?.field ?? null;
  const spec = method?.fields.find((candidate) => candidate.key === field);
  const holder = method?.fields.find((candidate) => candidate.holderName)?.key ?? null;
  switch (result.code) {
    case 'p2p.holder_name_mismatch':
      return { field: holder, text: t('refusedMismatch') };
    case 'p2p.holder_name_unverified':
      return { field: holder, text: t('refusedUnverified') };
    case 'p2p.holder_name_unverifiable':
      return { field: null, text: t('refusedUnverifiable') };
    case 'p2p.account_format_invalid':
      return { field, text: spec?.help ? t('refusedFormatHint', { hint: spec.help }) : t('refusedFormat') };
    case 'p2p.instrument_field_missing':
      return { field, text: t('refusedMissing') };
    case 'p2p.instrument_field_invalid':
      return { field, text: t('refusedInvalid', { min: String(spec?.minLength ?? 1), max: String(spec?.maxLength ?? 512) }) };
    case 'p2p.instrument_slot_taken':
      return { field: null, text: t('refusedSlot') };
    case 'p2p.instrument_method_disabled':
      return { field: null, text: t('refusedDisabled') };
    case 'p2p.instrument_method_unknown':
      return { field: null, text: t('refusedUnknown') };
    default:
      return null;
  }
}

function AddMethod({
  pay,
  methods,
  disabled,
  onSaved,
}: {
  pay: PersonalPayApi;
  methods: Method[];
  disabled: boolean;
  onSaved: () => void;
}) {
  const { t } = methodsCopy.useCopy();
  const fiat = useResource((signal) => pay.fiat(signal), 'pay:p2p-fiat');
  const countries = useMemo(
    () => [...new Set(methods.map((method) => method.country).filter((code) => code !== EVERYWHERE))].sort(),
    [methods],
  );
  const anyCountry = methods.some((method) => method.country === EVERYWHERE);
  const [country, setCountry] = useState('');
  const [methodId, setMethodId] = useState('');
  const [fiatCurrency, setFiatCurrency] = useState('');
  const [label, setLabel] = useState('');
  const [details, setDetails] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [saved, setSaved] = useState(false);
  // The new destination's id, minted once per form and kept until a save is answered: a resend after a lost answer is
  // the same destination, and pay-api settles a lost answer by finding this id in the person's list.
  const instrumentId = useRef(crypto.randomUUID());

  // A method registered for every country can be added for any country; the others only where they are registered.
  const countryOk = anyCountry ? /^[A-Z]{2}$/.test(country) : countries.includes(country);
  const offered = countryOk ? methodsIn(methods, country) : [];
  const method = offered.find((candidate) => candidate.methodId === methodId);
  const missing = method?.fields.filter((field) => field.required && !(details[field.key] ?? '').trim()) ?? [];
  const ready = Boolean(countryOk && method && fiatCurrency && missing.length === 0);

  function edit(change: () => void) {
    change();
    setRefused(null);
    setFailure(null);
    setSaved(false);
  }

  async function save() {
    if (!method || busy) return;
    setBusy(true);
    try {
      const values = Object.fromEntries(
        method.fields.map((field) => [field.key, (details[field.key] ?? '').trim()] as const).filter(([, value]) => value !== ''),
      );
      const result = await pay.addInstrument({
        instrumentId: instrumentId.current,
        methodId: method.methodId,
        country,
        fiatCurrency,
        label: label.trim(),
        details: values,
      });
      setReviewing(false);
      if (result.ok) {
        instrumentId.current = crypto.randomUUID();
        setDetails({});
        setLabel('');
        setSaved(true);
        onSaved();
        return;
      }
      // Refused: nothing was stored, so the next try may reuse the id.
      const known = refusalOf(result, method, t);
      if (known) setRefused(known);
      else setFailure(result);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="form-stack"
      data-testid="method-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !disabled) setReviewing(true);
      }}
    >
      <label className="field">
        <span>{t('addCountry')}</span>
        <input
          value={country}
          list="method-add-countries"
          maxLength={2}
          autoComplete="off"
          placeholder={t('addCountryPick')}
          disabled={disabled}
          onChange={(event) => edit(() => (setCountry(event.target.value.toUpperCase()), setMethodId('')))}
        />
        <datalist id="method-add-countries">
          {countries.map((code) => (
            <option key={code} value={code} />
          ))}
        </datalist>
        <small className="muted">{t(anyCountry ? 'addCountryAny' : 'addCountryListed')}</small>
      </label>
      <label className="field">
        <span>{t('addMethod')}</span>
        <select
          value={methodId}
          onChange={(event) => edit(() => (setMethodId(event.target.value), setDetails({})))}
          disabled={disabled || !countryOk}
        >
          <option value="">{t('addMethodPick')}</option>
          {offered.map((candidate) => (
            <option key={`${candidate.methodId}:${candidate.country}`} value={candidate.methodId}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('addFiat')}</span>
        <select value={fiatCurrency} onChange={(event) => edit(() => setFiatCurrency(event.target.value))} disabled={disabled}>
          <option value="">{t('addFiatPick')}</option>
          {fiat.resource.status === 'ready'
            ? fiat.resource.data.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} · {currency.name}
                </option>
              ))
            : null}
        </select>
      </label>
      {method?.fields.map((field) => {
        const error = refused?.field === field.key ? refused.text : null;
        return (
          <label className="field" key={field.key} data-field={field.key}>
            <span>{field.label}</span>
            <input
              value={details[field.key] ?? ''}
              autoComplete="off"
              spellCheck={false}
              maxLength={field.maxLength ?? 512}
              disabled={disabled}
              aria-invalid={Boolean(error)}
              onChange={(event) => edit(() => setDetails((current) => ({ ...current, [field.key]: event.target.value })))}
            />
            {error ? (
              <small className="error-text" role="alert">
                {error}
              </small>
            ) : field.holderName ? (
              <small className="muted">{t('addOwnName')}</small>
            ) : field.help ? (
              <small className="muted">{field.help}</small>
            ) : null}
          </label>
        );
      })}
      <label className="field">
        <span>{t('addLabel')}</span>
        <input value={label} maxLength={120} disabled={disabled} onChange={(event) => edit(() => setLabel(event.target.value))} />
        <small className="muted">{t('addLabelHint')}</small>
      </label>
      {refused && refused.field === null ? (
        <p className="failure" role="alert" data-testid="method-add-refused">
          {refused.text}
        </p>
      ) : null}
      {failure ? <PayFailure result={failure} /> : null}
      {saved ? (
        <p className="pay-confirmed" role="status" data-testid="method-add-saved">
          {t('addSaved')}
        </p>
      ) : null}
      <div className="actions">
        <Button type="submit" variant="primary" disabled={disabled || !ready}>
          {t('addReview')}
        </Button>
      </div>
      {reviewing && method ? (
        <Dialog closeLabel={uiCopy.t('closeDialog')} title={t('addReviewTitle')} onClose={() => (busy ? undefined : setReviewing(false))}>
          <div className="form-stack" data-testid="method-add-review">
            <p className="muted">{t('addReviewIntro')}</p>
            <dl className="pay-details">
              <dt>{t('addMethod')}</dt>
              <dd>{method.label}</dd>
              <dt>{t('addCountry')}</dt>
              <dd>{country}</dd>
              <dt>{t('addFiat')}</dt>
              <dd>{fiatCurrency}</dd>
              {method.fields
                .filter((field) => (details[field.key] ?? '').trim())
                .map((field) => (
                  <div key={field.key} style={{ display: 'contents' }}>
                    <dt>{field.label}</dt>
                    <dd lang="zxx">{details[field.key]!.trim()}</dd>
                  </div>
                ))}
            </dl>
            <div className="actions">
              <Button variant="ghost" disabled={busy} onClick={() => setReviewing(false)}>
                {t('addCancel')}
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void save()} data-testid="method-add-confirm">
                {t('addReviewTitle')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </form>
  );
}
