import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Field, Select } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { p2pInstrumentDetailsDigest } from '@intafaced/contracts/p2p-rule-class';
import type { StepUpBegin } from '../../account';
import { StepUpInline } from '../../money';
import { MethodStatus, MethodsFailure, MethodsLoad, MethodsNotice, MethodsPages, MethodsSection, ReviewedChange } from './methods-parts';
import { payCopy } from '../copy';
import type { PersonalPayApi } from '../pay-api';
import type { MethodField, MethodSchema } from '../schemas';
import { methodsCopy } from './payment-methods-copy';

type Method = MethodSchema;
type NoteRules = NonNullable<Method['noteRules']>;
type CashRules = NonNullable<Method['cashRules']>;
type Settlement = { instant: true } | { instant: false; windowSeconds: number | null };
type MethodsT = ReturnType<typeof methodsCopy.useCopy>['t'];

const EVERYWHERE = '*';

/** The room's three sections, by the id its index links to. */
export const METHODS_SECTIONS = { catalogue: 'p2p-methods-catalogue', add: 'p2p-methods-add', saved: 'p2p-methods-saved' } as const;

/** svc-p2p's payment-method confirmation refusals, in this room's words: nothing was changed, and what to do next. */
const STEP_UP_REFUSALS = {
  'auth.step_up_required': 'refusedStepUp',
  'auth.step_up_expired': 'refusedStepUpExpired',
  'auth.step_up_failed': 'refusedStepUpFailed',
  'p2p.step_up_unverifiable': 'refusedStepUpUnchecked',
  'p2p.instrument_kms_required': 'keyOff',
} as const;

/**
 * What the person confirms for one change: the method's id, the kind of change and the digest of the details it saves
 * (empty for a removal). svc-p2p hashes the same from the request, so the confirmation approves this account number only.
 */
const changeStepUp = (instrumentId: string, change: 'create' | 'remove', detailsDigest: string): StepUpBegin => ({
  scope: 'p2p.step_up.instruments.change',
  purpose: 'instruments.change',
  target: instrumentId,
  fields: { instrumentId, change, detailsDigest },
});

/**
 * P2P payment methods (P-ads-merchant-18, -19; J-p2p-04): what each method asks for per country, adding one in the
 * person's own name, and the ones they hold. Every add and removal is confirmed with a passkey or authenticator code.
 * Whole saved values never come back here: the list shows the person's own labels, "Show details" reads them masked
 * through svc-p2p's logged read, and a buyer sees the details only on an order placed with them.
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
    <>
      {keyOff ? (
        <div data-testid="methods-key-off">
          <MethodsNotice title={t('keyOffTitle')}>{t('keyOff')}</MethodsNotice>
        </div>
      ) : null}
      <MethodsSection id={METHODS_SECTIONS.catalogue} title={t('catalogueTitle')} description={t('catalogueIntro')}>
        <MethodsState resource={catalogue.resource} retry={catalogue.reload}>
          {(methods) => <Catalogue methods={methods} />}
        </MethodsState>
      </MethodsSection>
      <MethodsSection id={METHODS_SECTIONS.add} title={t('addTitle')} description={t('addIntro')}>
        <MethodsState resource={catalogue.resource} retry={catalogue.reload}>
          {(methods) => (
            <AddMethod pay={pay} methods={methods.filter((method) => method.enabled)} disabled={!keyOn} onSaved={instruments.reload} />
          )}
        </MethodsState>
      </MethodsSection>
      <MethodsSection id={METHODS_SECTIONS.saved} title={payCopy.t('yourPaymentDestinationLabels')}>
        <MethodsLoad resource={instruments.resource} retry={instruments.reload} empty={payCopy.t('noPaymentDestinationHeadersReturned')}>
          {(rows) => (
            <>
              <table className="lt-table" aria-label={payCopy.t('paymentDestinations')}>
                <thead>
                  <tr>
                    <th scope="col">{payCopy.t('label')}</th>
                    <th scope="col">{payCopy.t('method')}</th>
                    <th scope="col">{payCopy.t('currencyCountry')}</th>
                    <th scope="col">{payCopy.t('state')}</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((instrument) => (
                    <tr key={instrument.id} data-testid="saved-method" data-instrument-id={instrument.id}>
                      <td>{instrument.label || payCopy.t('unlabelledDestination')}</td>
                      <td>{instrument.methodId}</td>
                      <td>
                        {instrument.fiatCurrency} / {instrument.country}
                      </td>
                      <td>
                        <MethodStatus value={instrument.status} />
                      </td>
                      <td>
                        {instrument.status === 'active' && (
                          <div className="lt-actions">
                            <SavedDetails
                              pay={pay}
                              instrumentId={instrument.id}
                              fields={fieldsOf(catalogue.resource, instrument.methodId, instrument.country)}
                            />
                            <RemoveMethod pay={pay} instrumentId={instrument.id} onRemoved={instruments.reload} />
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <MethodsPages count={rows.length} limit={limit} setLimit={setLimit} />
            </>
          )}
        </MethodsLoad>
      </MethodsSection>
    </>
  );
}

/** The catalogue's fields for a saved method, by the row svc-p2p validated it against; null while unread or unknown. */
function fieldsOf(resource: ReturnType<typeof useResource<Method[]>>['resource'], methodId: string, country: string) {
  if (resource.status !== 'ready') return null;
  return methodsIn(resource.data, country).find((method) => method.methodId === methodId)?.fields ?? null;
}

/**
 * The person's own saved details, masked (J-p2p-04 #3), read only when asked for. svc-p2p masks them (the account holder
 * whole, every other value as its last four) and logs the read like any other, so the whole account number never
 * reaches the browser on this path.
 */
function SavedDetails({ pay, instrumentId, fields }: { pay: PersonalPayApi; instrumentId: string; fields: MethodField[] | null }) {
  const { t } = methodsCopy.useCopy();
  const [shown, setShown] = useState<ApiResult<{ details: Record<string, string> }> | 'loading' | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  async function show() {
    setShown('loading');
    const result = await pay.maskedInstrument(instrumentId);
    if (alive.current) setShown(result);
  }
  if (shown === null)
    return (
      <Button tone="quiet" onClick={() => void show()} data-testid="saved-method-show">
        {t('detailsShow')}
      </Button>
    );
  if (shown === 'loading')
    return (
      <p className="lt-hint" role="status">
        {t('detailsLoading')}
      </p>
    );
  const hide = (
    <Button tone="quiet" onClick={() => setShown(null)}>
      {t('detailsHide')}
    </Button>
  );
  if (!shown.ok)
    return (
      <div>
        <MethodsFailure result={shown} />
        {hide}
      </div>
    );
  return (
    <div data-testid="saved-method-details">
      <dl className="lt-kv">
        {Object.entries(shown.data.details).map(([key, value]) => (
          <div key={key}>
            <dt>{fields?.find((field) => field.key === key)?.label ?? key}</dt>
            <dd lang="zxx" data-field={key}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="lt-hint">{t('detailsLogged')}</p>
      {hide}
    </div>
  );
}

/** Removing a saved method, confirmed with a passkey or authenticator code each time. */
type Impact = { fiatCurrency: string; ads: Array<{ offerId: string; asset: string; pauses: boolean }> };

function RemoveMethod({ pay, instrumentId, onRemoved }: { pay: PersonalPayApi; instrumentId: string; onRemoved: () => void }) {
  const { t } = methodsCopy.useCopy();
  // undefined: not confirmed yet; null: no factor on the account, so the removal goes without one and svc-p2p decides.
  const [approval, setApproval] = useState<string | null | undefined>(undefined);
  // P-ads-merchant-18: which ads lose their last payable method, read when the review opens; they pause with it.
  const [impact, setImpact] = useState<Impact | null>(null);
  const [impactRead, setImpactRead] = useState(0);
  return (
    <ReviewedChange
      title={payCopy.t('removeDestination')}
      description={payCopy.t('thisRemovesTheDestinationFromFutureTrades')}
      review={
        <div>
          <ImpactRead key={impactRead} pay={pay} instrumentId={instrumentId} onRead={setImpact} />
          {approval === undefined ? (
            <StepUpInline
              request={() => changeStepUp(instrumentId, 'remove', '')}
              words={stepUpWords(t, 'stepUpSendRemove')}
              disabled={impact === null}
              onApproved={(id) => setApproval(id)}
            />
          ) : (
            <p className="lt-hint" role="status" data-testid="method-remove-confirmed">
              {approval ? t('stepUpDone') : t('stepUpNone')}
            </p>
          )}
        </div>
      }
      ready={approval !== undefined && impact !== null}
      notReadyReason={t('stepUpFirst')}
      perform={async () => {
        // The ads shown pausing are the ones agreed to: svc-p2p refuses if any other would pause.
        const pausing = (impact?.ads ?? []).filter((ad) => ad.pauses).map((ad) => ad.offerId);
        const result = await pay.removeInstrument(instrumentId, approval ?? undefined, pausing);
        // A confirmation is spent once, kept or refused: the next try asks again.
        if (!result.ok) {
          setApproval(undefined);
          // An ad went up between the read and the confirmation: show the list again before anything pauses.
          if (result.code === 'p2p.method_in_use') {
            setImpact(null);
            setImpactRead((n) => n + 1);
            return { ...result, message: t('removeImpactChanged') };
          }
          const words = result.code ? STEP_UP_REFUSALS[result.code as keyof typeof STEP_UP_REFUSALS] : undefined;
          if (words) return { ...result, message: t(words) };
        }
        return result;
      }}
      onConfirmed={onRemoved}
    />
  );
}

/** Reads what the removal does to the person's ads each time the review opens, and shows it. */
function ImpactRead({ pay, instrumentId, onRead }: { pay: PersonalPayApi; instrumentId: string; onRead: (impact: Impact | null) => void }) {
  const impact = useResource((signal) => pay.methodRemovalImpact(instrumentId, signal), `pay:method-removal:${instrumentId}`);
  const data = impact.resource.status === 'ready' ? impact.resource.data : null;
  useEffect(() => onRead(data), [data, onRead]);
  return (
    <MethodsLoad resource={impact.resource} retry={impact.reload}>
      {(read) => <RemovalImpact impact={read} />}
    </MethodsLoad>
  );
}

function RemovalImpact({ impact }: { impact: Impact }) {
  const { t } = methodsCopy.useCopy();
  const pausing = impact.ads.filter((ad) => ad.pauses).length;
  if (impact.ads.length === 0)
    return (
      <p className="lt-hint" data-testid="method-remove-impact">
        {t('removeImpactNone')}
      </p>
    );
  return (
    <section data-testid="method-remove-impact" aria-label={t('removeImpactTitle')}>
      {pausing > 0 ? (
        <p role="alert" data-testid="method-remove-warning">
          <strong>{t('removeImpactWarning', { count: String(pausing), fiat: impact.fiatCurrency })}</strong>
        </p>
      ) : null}
      <h3>{t('removeImpactTitle')}</h3>
      <ul>
        {impact.ads.map((ad) => (
          <li key={ad.offerId} data-offer-id={ad.offerId} data-pauses={ad.pauses ? 'true' : 'false'}>
            <a className="lt-link" href={`/uc/ad?offerId=${encodeURIComponent(ad.offerId)}`} lang="zxx">
              {ad.asset} · {ad.offerId.slice(0, 8)}
            </a>{' '}
            <span className="lt-hint">{ad.pauses ? t('removeImpactPauses') : t('removeImpactStays')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function stepUpWords(t: MethodsT, send: 'stepUpSendSave' | 'stepUpSendRemove') {
  return {
    why: t('stepUpWhy'),
    code: t('stepUpCode'),
    codeHint: t('stepUpCodeHint'),
    codeShort: t('stepUpCodeShort'),
    noFactor: t('stepUpNoFactor'),
    sendWithout: t(send),
  };
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
    return <p className="lt-hint">{t('catalogueUnset')}</p>;
  return (
    <MethodsLoad resource={resource} retry={retry}>
      {(methods) => (methods.length === 0 ? <p className="lt-hint">{t('catalogueUnset')}</p> : children(methods))}
    </MethodsLoad>
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
    <div className="lt-stack" data-testid="methods-catalogue">
      <Select
        label={t('catalogueCountry')}
        value={country}
        onChange={setCountry}
        options={countries.map((code) => ({ value: code, label: countryName(code, t('catalogueEverywhere')) }))}
      />
      <ul className="lt-rows">
        {shown.map((method) => (
          <li key={`${method.methodId}:${method.country}`}>
            <article className="lt-stack" data-testid="catalogue-method" data-method={method.methodId} data-country={method.country}>
              <div className="lt-title-row">
                <h3>{method.label}</h3>
                <MethodStatus value={method.enabled ? 'enabled' : 'disabled'} />
              </div>
              <p className="lt-hint">{countryName(method.country, t('catalogueEverywhere'))}</p>
              {method.settlement ? <p className="lt-hint">{settlementText(method.settlement, t)}</p> : null}
              <p>{t('catalogueAsks')}:</p>
              <ul>
                {method.fields.map((field) => (
                  <li key={field.key}>
                    {field.label} ({t(field.required ? 'catalogueRequired' : 'catalogueOptional')}){field.help ? `: ${field.help}` : ''}
                  </li>
                ))}
              </ul>
              {method.fields.some((field) => field.holderName) ? <p data-testid="catalogue-own-name">{t('catalogueOwnName')}</p> : null}
              {method.cashRules ? <CashRulesView rules={method.cashRules} /> : null}
              {method.noteRules ? <NoteRulesView rules={method.noteRules} /> : null}
            </article>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** P-ads-merchant-19: the cash-in-person rules the method row carries: a locked price, the meeting, the proof, the release window. */
function CashRulesView({ rules }: { rules: CashRules }) {
  const { t } = methodsCopy.useCopy();
  return (
    <div data-testid="catalogue-cash-rules">
      <strong>{t('cashTitle')}</strong>
      <p>{t('cashLocked')}</p>
      <p>
        {t('cashMeeting')}: {rules.meetingGuidance}
      </p>
      <p>
        {t('cashProof')}: {rules.proof}
      </p>
      <p data-testid="catalogue-cash-release">{releaseText(rules.releaseWindowSeconds, t)}</p>
    </div>
  );
}

/**
 * The seller's release window in words. A deadline is never shown longer than it is: whole minutes round down, and the
 * seconds show when they are not whole minutes.
 */
function releaseText(seconds: number, t: MethodsT) {
  if (seconds % 60 !== 0) return t('cashReleaseSeconds', { seconds: String(seconds) });
  const minutes = seconds / 60;
  if (minutes < 60) return t('cashRelease', { minutes: String(minutes) });
  if (minutes % 60 === 0) return t('cashReleaseHours', { hours: String(minutes / 60) });
  return t('cashReleaseHoursMinutes', { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) });
}

/** P-ads-merchant-19: what the payer writes in the payment note, and the words that never go in it. */
function NoteRulesView({ rules }: { rules: NoteRules }) {
  const { t } = methodsCopy.useCopy();
  return (
    <div data-testid="catalogue-note-rules">
      <strong>{t('noteTitle')}</strong>
      <p>{rules.guidance}</p>
      {rules.forbidden.length > 0 ? (
        <p data-testid="catalogue-note-forbidden">
          {t('noteForbidden')}: {rules.forbidden.join(', ')}
        </p>
      ) : null}
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
    case 'auth.step_up_required':
    case 'auth.step_up_expired':
    case 'auth.step_up_failed':
    case 'p2p.step_up_unverifiable':
    case 'p2p.instrument_kms_required':
      return { field: null, text: t(STEP_UP_REFUSALS[result.code]) };
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
  // The digest of exactly the details under review, which the confirmation names; null while it is worked out.
  const [digest, setDigest] = useState<string | null>(null);
  const reviewToken = useRef(0);
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

  /** The details as the save sends them: each declared field, trimmed, the blank ones left out. */
  function values(of: Method): Record<string, string> {
    return Object.fromEntries(
      of.fields.map((field) => [field.key, (details[field.key] ?? '').trim()] as const).filter(([, value]) => value !== ''),
    );
  }

  async function review() {
    if (!method) return;
    const token = ++reviewToken.current;
    setReviewing(true);
    setDigest(null);
    const named = await p2pInstrumentDetailsDigest(values(method));
    if (reviewToken.current === token) setDigest(named);
  }

  async function save(stepUpApprovalId?: string) {
    if (!method || busy) return;
    setBusy(true);
    try {
      const result = await pay.addInstrument({
        instrumentId: instrumentId.current,
        methodId: method.methodId,
        country,
        fiatCurrency,
        label: label.trim(),
        details: values(method),
        ...(stepUpApprovalId ? { stepUpApprovalId } : {}),
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

  const closeReview = () => (busy ? undefined : (reviewToken.current++, setReviewing(false)));
  return (
    <>
      <form
        className="lt-stack"
        data-testid="method-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !disabled) void review();
        }}
      >
        <Field
          label={t('addCountry')}
          hint={t(anyCountry ? 'addCountryAny' : 'addCountryListed')}
          value={country}
          list="method-add-countries"
          data-testid="method-add-country"
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
        <Select
          label={t('addMethod')}
          data-testid="method-add-method"
          value={methodId}
          onChange={(value) => edit(() => (setMethodId(value), setDetails({})))}
          disabled={disabled || !countryOk}
          options={[
            { value: '', label: t('addMethodPick') },
            ...offered.map((candidate) => ({ value: candidate.methodId, label: candidate.label })),
          ]}
        />
        <Select
          label={t('addFiat')}
          data-testid="method-add-fiat"
          value={fiatCurrency}
          onChange={(value) => edit(() => setFiatCurrency(value))}
          disabled={disabled}
          options={[
            { value: '', label: t('addFiatPick') },
            ...(fiat.resource.status === 'ready'
              ? fiat.resource.data.map((currency) => ({ value: currency.code, label: `${currency.code} · ${currency.name}` }))
              : []),
          ]}
        />
        {method?.fields.map((field) => {
          const error = refused?.field === field.key ? refused.text : undefined;
          return (
            <div key={field.key} data-field={field.key}>
              <Field
                label={field.label}
                error={error}
                hint={error ? undefined : field.holderName ? t('addOwnName') : (field.help ?? undefined)}
                value={details[field.key] ?? ''}
                autoComplete="off"
                spellCheck={false}
                maxLength={field.maxLength ?? 512}
                disabled={disabled}
                onChange={(event) => edit(() => setDetails((current) => ({ ...current, [field.key]: event.target.value })))}
              />
            </div>
          );
        })}
        <Field
          label={t('addLabel')}
          hint={t('addLabelHint')}
          value={label}
          maxLength={120}
          disabled={disabled}
          onChange={(event) => edit(() => setLabel(event.target.value))}
        />
        {refused && refused.field === null ? (
          <p role="alert" data-testid="method-add-refused">
            <strong>{refused.text}</strong>
          </p>
        ) : null}
        {failure ? <MethodsFailure result={failure} /> : null}
        {saved ? (
          <p className="lt-hint" role="status" data-testid="method-add-saved">
            {t('addSaved')}
          </p>
        ) : null}
        <div className="lt-actions">
          <Button type="submit" tone="primary" disabled={disabled || !ready}>
            {t('addReview')}
          </Button>
        </div>
      </form>
      {reviewing && method ? (
        <Sheet open title={t('addReviewTitle')} onClose={closeReview}>
          <div data-testid="method-add-review">
            <p className="lt-hint">{t('addReviewIntro')}</p>
            <dl className="lt-kv">
              <div>
                <dt>{t('addMethod')}</dt>
                <dd>{method.label}</dd>
              </div>
              <div>
                <dt>{t('addCountry')}</dt>
                <dd>{country}</dd>
              </div>
              <div>
                <dt>{t('addFiat')}</dt>
                <dd>{fiatCurrency}</dd>
              </div>
              {method.fields
                .filter((field) => (details[field.key] ?? '').trim())
                .map((field) => (
                  <div key={field.key}>
                    <dt>{field.label}</dt>
                    <dd lang="zxx">{details[field.key]!.trim()}</dd>
                  </div>
                ))}
            </dl>
            {/* Confirming saves: the passkey or code approves exactly these details. */}
            {digest === null ? null : (
              <StepUpInline
                request={() => changeStepUp(instrumentId.current, 'create', digest)}
                words={stepUpWords(t, 'stepUpSendSave')}
                disabled={busy}
                onApproved={(id) => void save(id ?? undefined)}
              />
            )}
            {busy ? (
              <p className="lt-hint" role="status">
                {t('addSaving')}
              </p>
            ) : null}
            <div className="lt-actions">
              <Button tone="quiet" disabled={busy} onClick={() => (reviewToken.current++, setReviewing(false))}>
                {t('addCancel')}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
