import { useMemo, useRef, useState } from 'react';
import { useResource } from '../../../shared/resource';
import { EmptyState } from '../ui-kit';
import type { ApiResult } from '../../../shared/api';
import { PayDetails, PayFailure, PayState, PayTime } from '../components';
import type { PersonalPayApi } from '../pay-api';
import { id, type Offer, type OfferUpdateInput } from '../schemas';
import { myAdsCopy } from './p2p-my-ads-copy';
import { p2pDepth } from './p2p-depth-copy';
import {
  checkOfferForm,
  emptyOffer,
  offerChanges,
  offerToForm,
  type OfferFormField,
  type OfferFormProblem,
  type OfferFormValues,
} from './p2p-model';
import { settlementCopy } from './settlement-copy';
import { P2PReason } from './P2PDepth';
import { Button } from '@intafaced/ui';
import { AdvertiserTermsSheet, LevelLimits, OfferReceipt, OfferSummary, PostingChecklist, SellAvailability, postInput } from './p2p-post';
import { postCopy } from './p2p-post-copy';
import './p2p-depth.css';

/**
 * Create offer (/uc/ad/create) and edit offer (/uc/ad/update?offerId=…).
 * Create (P-ads-merchant-01): the form, a summary of every field, the advertiser terms when they are not yet accepted,
 * then one ad, posted under a business key made once per form so a second press or a retry answers the same ad. Edit
 * keeps its exact-decimal checks and the list of what changed, and saves only the changed fields (P-ads-merchant-06),
 * counted once against the day's edit cap; open orders keep the terms they were taken on.
 */
export function OfferForm({
  pay,
  userId,
  mode,
  offerId,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  mode: 'create' | 'edit';
  offerId: string | null;
}) {
  const { t, languageFor, directionFor } = p2pDepth.useCopy();
  const valid = offerId !== null && id.safeParse(offerId).success;
  // An edit with no offer chosen shows no form at all: there is nothing to edit and nothing to type into.
  if (mode === 'edit' && !valid)
    return (
      <div className="p2p-form" lang={languageFor('formCreateTitle')} dir={directionFor('formCreateTitle')} data-testid="offer-pick">
        <EmptyState
          title={t('editPickTitle')}
          action={
            <a className="button button--primary" href="/uc/ad">
              {t('backToOffers')}
            </a>
          }
        >
          {t('editPickBody')}
        </EmptyState>
      </div>
    );
  return (
    <div className="p2p-form" lang={languageFor('formCreateTitle')} dir={directionFor('formCreateTitle')}>
      {mode === 'create' ? (
        <CreateOffer pay={pay} userId={userId} />
      ) : (
        <div data-testid="offer-form">
          <EditLive pay={pay} userId={userId} offerId={offerId!.toLowerCase()} />
        </div>
      )}
    </div>
  );
}

/**
 * The ad this form posts: its id is chosen once per form, and the post's key is that id, so every press and retry of
 * this ad names the same ad and a new form names a new one.
 */
const newAd = () => {
  const offerId = crypto.randomUUID();
  return { offerId, key: `p2p:offer-create:${offerId}` };
};

type Stage = { kind: 'form' } | { kind: 'summary' } | { kind: 'posted'; offer: Offer };

/** P-ads-merchant-01: fill the form, check the summary, accept the advertiser terms if asked, post once. */
function CreateOffer({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const { t } = postCopy.useCopy();
  const [values, setValues] = useState<OfferFormValues>(emptyOffer);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [ad, setAd] = useState(newAd);
  const terms = useResource((signal) => pay.advertiserTerms(signal), `pay:p2p-advertiser-terms:${userId}`);
  const methods = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  const health = useResource((signal) => pay.health(signal), 'pay:p2p-health');
  // The version last seen or accepted, so a Post pressed while the terms are re-read still sends it.
  const [knownVersion, setKnownVersion] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [posting, setPosting] = useState(false);
  // A double tap sends one post: the second press finds this set before React has re-rendered the button.
  const inFlight = useRef(false);
  const version = terms.resource.status === 'ready' ? terms.resource.data.version : knownVersion;
  const keyOff = health.resource.status === 'ready' && health.resource.data.instrumentKeyProvider !== 'local-test';
  const acceptedNote =
    terms.resource.status === 'ready'
      ? terms.resource.data.acceptedAt
        ? t('termsAccepted', { version: terms.resource.data.version })
        : t('termsNeeded', { version: terms.resource.data.version })
      : terms.resource.status === 'failed'
        ? terms.resource.failure.code === 'p2p.config_unset'
          ? t('termsUnset')
          : t('termsFailed')
        : null;
  const input = postInput(values);
  const registered = methods.resource.status === 'ready' ? methods.resource.data : [];
  const labels = input.methods.map((method) => registered.find((row) => row.methodId === method)?.label ?? method);
  const post = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPosting(true);
    setFailure(null);
    // No published version to send yet (still loading, unreadable or unset): read it again; the note says which.
    if (!version) {
      inFlight.current = false;
      setPosting(false);
      terms.reload();
      return;
    }
    const termsVersion = version;
    const result = await pay.postOffer({ ...input, offerId: ad.offerId }, ad.key, termsVersion);
    inFlight.current = false;
    setPosting(false);
    if (result.ok) {
      setStage({ kind: 'posted', offer: result.data });
      return;
    }
    if (result.code === 'p2p.terms_not_accepted') {
      setSheet(termsVersion);
      return;
    }
    if (result.code === 'p2p.terms_version_stale') {
      const fresh = await pay.advertiserTerms();
      terms.reload();
      if (fresh.ok) {
        setKnownVersion(fresh.data.version);
        setNote(t('termsStale', { version: fresh.data.version }));
        setSheet(fresh.data.version);
        return;
      }
    }
    setFailure(result);
  };
  if (stage.kind === 'posted')
    return (
      <OfferReceipt
        offer={stage.offer}
        onAnother={() => {
          setValues(emptyOffer());
          setAd(newAd());
          setNote(null);
          setStage({ kind: 'form' });
        }}
      />
    );
  return (
    <>
      {stage.kind === 'form' ? (
        <div data-testid="offer-form">
          {keyOff ? <P2PReason title={t('keyOffTitle')}>{t('keyOff')}</P2PReason> : null}
          {acceptedNote ? <p className="muted">{acceptedNote}</p> : null}
          <Fields
            pay={pay}
            baseline={values}
            mode="create"
            onReview={(reviewed) => {
              setValues(reviewed);
              setFailure(null);
              setStage({ kind: 'summary' });
            }}
          />
        </div>
      ) : (
        <OfferSummary
          input={input}
          methodLabels={labels}
          termsNote={note ?? acceptedNote}
          failure={failure}
          posting={posting}
          onConfirm={() => void post()}
          onBack={() => {
            setFailure(null);
            setStage({ kind: 'form' });
          }}
        />
      )}
      {sheet ? (
        <AdvertiserTermsSheet
          pay={pay}
          version={sheet}
          onClose={() => setSheet(null)}
          onAccepted={(accepted) => {
            setKnownVersion(accepted);
            setSheet(null);
            setNote(t('termsNowAccepted', { version: accepted }));
            terms.reload();
          }}
        />
      ) : null}
    </>
  );
}

/** The live offer, read from the service, as the starting point of the edit form. */
function EditLive({ pay, userId, offerId }: { pay: PersonalPayApi; userId: string | null; offerId: string }) {
  const { t } = p2pDepth.useCopy();
  const offer = useResource((signal) => pay.offer(offerId, signal), `pay:offer-form:${userId}:${offerId}`);
  return (
    <PayState resource={offer.resource} retry={offer.reload}>
      {(live) => (
        <>
          {live.makerId !== userId ? (
            <p className="error-text" data-testid="offer-not-yours">
              {t('editNotYours')}
            </p>
          ) : (
            <EditSave pay={pay} live={live} />
          )}
        </>
      )}
    </PayState>
  );
}

/** The changed editable fields of an ad, as `offers.update` takes them. Coin, currency and side stay as posted. */
function updateInput(before: OfferFormValues, after: OfferFormValues): OfferUpdateInput | 'pairFixed' | null {
  const changed = offerChanges(before, after);
  if (changed.includes('asset') || changed.includes('fiatCurrency')) return 'pairFixed';
  if (changed.length === 0) return null;
  const input = postInput(after);
  return {
    ...(changed.includes('price') ? { price: input.price } : {}),
    ...(changed.includes('minAmount') ? { minAmount: input.minAmount } : {}),
    ...(changed.includes('maxAmount') ? { maxAmount: input.maxAmount } : {}),
    ...(changed.includes('totalAmount') && input.totalAmount !== undefined ? { totalAmount: input.totalAmount } : {}),
    ...(changed.includes('methods') ? { methods: input.methods } : {}),
    ...(changed.includes('terms') ? { terms: after.terms.trim() } : {}),
  };
}

/** P-ads-merchant-06: edit a published ad and save it, once per press, under one key for this form. */
function EditSave({ pay, live }: { pay: PersonalPayApi; live: Offer }) {
  const { t } = p2pDepth.useCopy();
  const myAds = myAdsCopy.useCopy();
  const baseline = useMemo(() => offerToForm(live), [live]);
  const [key] = useState(() => `p2p:offer-edit:${live.id}:${crypto.randomUUID()}`);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ApiResult<Offer> | 'pairFixed' | 'unchanged' | null>(null);
  const inFlight = useRef(false);
  const save = async (values: OfferFormValues) => {
    if (inFlight.current) return;
    const input = updateInput(baseline, values);
    if (input === 'pairFixed' || input === null) {
      setResult(input ?? 'unchanged');
      return;
    }
    inFlight.current = true;
    setSaving(true);
    const outcome = await pay.updateOffer(live.id, input, key);
    inFlight.current = false;
    setSaving(false);
    setResult(outcome);
  };
  return (
    <>
      {live.status === 'closed' ? <p className="muted">{t('editClosed')}</p> : null}
      <Fields key={live.id} pay={pay} baseline={baseline} mode="edit" onReview={(values) => void save(values)} />
      {saving ? <p className="muted">{myAds.t('editSaving')}</p> : null}
      {result === 'pairFixed' ? (
        <p className="error-text" role="status">
          {myAds.t('editPairFixed')}
        </p>
      ) : result === 'unchanged' ? (
        <p className="muted" role="status">
          {t('noChanges')}
        </p>
      ) : result?.ok ? (
        <p role="status" data-testid="offer-edit-saved">
          {myAds.t('editSaved')}{' '}
          <a className="text-link" href="/uc/ad">
            {myAds.t('editBack')}
          </a>
        </p>
      ) : result && result.code === 'p2p.edit_quota_reached' && result.p2pLimit?.until ? (
        <p className="error-text" role="status" data-testid="offer-edit-spent">
          {myAds.t('editSpentAt', { limit: result.p2pLimit.cap ?? '' })} <PayTime value={result.p2pLimit.until} />
        </p>
      ) : result ? (
        <PayFailure result={result} />
      ) : null}
    </>
  );
}

const PROBLEM_KEY = {
  required: 'problemRequired',
  invalid: 'problemInvalid',
  minTooHigh: 'problemMinTooHigh',
  totalTooLow: 'problemTotalTooLow',
  tooLong: 'problemTooLong',
  nonInstantConsent: 'problemNonInstantConsent',
} as const satisfies Record<OfferFormProblem, string>;

const FIELD_LABEL = {
  asset: 'fieldAsset',
  fiatCurrency: 'fieldFiat',
  price: 'fieldPrice',
  minAmount: 'fieldMin',
  maxAmount: 'fieldMax',
  totalAmount: 'fieldTotal',
  methods: 'fieldMethods',
  terms: 'fieldTerms',
} as const satisfies Record<OfferFormField, string>;

function Fields({
  pay,
  baseline,
  mode,
  onReview,
}: {
  pay: PersonalPayApi;
  baseline: OfferFormValues;
  mode: 'create' | 'edit';
  /** Create only: the complete form goes to the summary. */
  onReview?: (values: OfferFormValues) => void;
}) {
  const { t } = p2pDepth.useCopy();
  const [values, setValues] = useState<OfferFormValues>(baseline);
  const fiat = useResource((signal) => pay.fiat(signal), 'pay:fiat');
  const methods = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  // P-disputes-security-09: the registry's methods that are not instant in some market.
  const nonInstant = useMemo(
    () =>
      new Set(
        methods.resource.status === 'ready'
          ? methods.resource.data.filter((method) => method.settlement?.instant === false).map((method) => method.methodId.toLowerCase())
          : [],
      ),
    [methods.resource],
  );
  const choseNonInstant = values.side === 'sell' && values.methods.some((method) => nonInstant.has(method.toLowerCase()));
  const problems = useMemo(() => checkOfferForm(values, nonInstant), [values, nonInstant]);
  const set = <K extends keyof OfferFormValues>(key: K, value: OfferFormValues[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }));
  const shown = (field: OfferFormField) => {
    const problem = problems[field];
    // "Required" is not shown while a field is still blank; everything else is shown at once.
    if (!problem || problem === 'required') return undefined;
    // An edit keeps the consent the ad was posted with, so the way out is a new ad, not a tick.
    return problem === 'nonInstantConsent' && mode === 'edit' ? t('problemNonInstantEdit') : t(PROBLEM_KEY[problem]);
  };
  const complete = Object.keys(problems).length === 0;
  const changed = mode === 'edit' ? offerChanges(baseline, values) : [];
  const text = (
    field: 'asset' | 'price' | 'minAmount' | 'maxAmount' | 'totalAmount',
    label: string,
    extra?: { upper?: boolean; mode?: 'decimal' },
  ) => (
    <label className="field" key={field}>
      <span>{label}</span>
      <input
        value={values[field]}
        inputMode={extra?.mode}
        autoComplete="off"
        maxLength={field === 'asset' ? 16 : 40}
        aria-invalid={Boolean(shown(field))}
        onChange={(event) => set(field, extra?.upper ? event.target.value.toUpperCase() : event.target.value)}
      />
      {shown(field) ? <small className="error-text">{shown(field)}</small> : null}
    </label>
  );
  return (
    <form
      className="form-stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && onReview) onReview(values);
      }}
    >
      <fieldset className="p2p-form">
        <div>
          <span className="p2p-legend">{t('sideLabel')}</span>
          <div className="p2p-radio-row" role="radiogroup" aria-label={t('sideLabel')}>
            <label>
              <input type="radio" name="offer-side" checked={values.side === 'sell'} onChange={() => set('side', 'sell')} />
              {t('sideSell')}
            </label>
            <label>
              <input type="radio" name="offer-side" checked={values.side === 'buy'} onChange={() => set('side', 'buy')} />
              {t('sideBuy')}
            </label>
          </div>
        </div>
        <div className="form-row">
          {text('asset', t('fieldAsset'), { upper: true })}
          <label className="field">
            <span>{t('fieldFiat')}</span>
            {fiat.resource.status === 'ready' ? (
              <select
                value={values.fiatCurrency}
                onChange={(event) => set('fiatCurrency', event.target.value)}
                aria-invalid={Boolean(shown('fiatCurrency'))}
              >
                <option value="">{t('fieldFiatPick')}</option>
                {fiat.resource.data.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} · {currency.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={values.fiatCurrency}
                maxLength={3}
                autoComplete="off"
                onChange={(event) => set('fiatCurrency', event.target.value.toUpperCase())}
                aria-invalid={Boolean(shown('fiatCurrency'))}
              />
            )}
            {shown('fiatCurrency') ? <small className="error-text">{shown('fiatCurrency')}</small> : null}
          </label>
        </div>
        {mode === 'create' ? <PostingChecklist pay={pay} fiatCurrency={problems.fiatCurrency ? '' : values.fiatCurrency.trim()} /> : null}
        <div>
          <span className="p2p-legend">{t('fieldPriceType')}</span>
          <div className="p2p-radio-row" role="radiogroup" aria-label={t('fieldPriceType')}>
            <label>
              <input
                type="radio"
                name="offer-price-type"
                checked={values.priceType === 'fixed'}
                onChange={() => set('priceType', 'fixed')}
              />
              {t('priceFixed')}
            </label>
            <label>
              <input
                type="radio"
                name="offer-price-type"
                checked={values.priceType === 'float'}
                onChange={() => set('priceType', 'float')}
              />
              {t('priceFloat')}
            </label>
          </div>
        </div>
        {text('price', values.priceType === 'float' ? t('fieldMultiplier') : t('fieldPrice'), { mode: 'decimal' })}
        <div className="form-row">
          {text('minAmount', t('fieldMin'), { mode: 'decimal' })}
          {text('maxAmount', t('fieldMax'), { mode: 'decimal' })}
        </div>
        {text('totalAmount', t('fieldTotal'), { mode: 'decimal' })}
        {mode === 'create' && values.side === 'sell' && !problems.asset ? (
          <SellAvailability pay={pay} asset={values.asset.trim().toUpperCase()} />
        ) : null}
        {mode === 'create' ? <LevelLimits pay={pay} side={values.side} /> : null}
        <div>
          <span className="p2p-legend">{t('fieldMethods')}</span>
          {methods.resource.status === 'loading' ? <p className="muted">{t('methodsLoading')}</p> : null}
          {methods.resource.status === 'failed' ? <PayFailure result={methods.resource.failure} retry={methods.reload} /> : null}
          {methods.resource.status === 'ready' && methods.resource.data.filter((method) => method.enabled).length === 0 ? (
            <p className="muted">{t('methodsNone')}</p>
          ) : null}
          {methods.resource.status === 'ready' ? (
            <div className="p2p-check-list">
              {methods.resource.data
                .filter((method) => method.enabled || values.methods.includes(method.methodId))
                .map((method) => (
                  <label key={`${method.methodId}:${method.country}`}>
                    <input
                      type="checkbox"
                      checked={values.methods.includes(method.methodId)}
                      onChange={(event) =>
                        set(
                          'methods',
                          event.target.checked
                            ? [...values.methods, method.methodId]
                            : values.methods.filter((item) => item !== method.methodId),
                        )
                      }
                    />
                    <span lang="und">{method.label}</span>
                  </label>
                ))}
            </div>
          ) : null}
          {choseNonInstant ? (
            <label className="p2p-check-list" data-testid="offer-non-instant-consent">
              <input
                type="checkbox"
                checked={values.acceptsNonInstant}
                // The consent is given at post; an edit keeps what the ad was posted with.
                disabled={mode === 'edit'}
                onChange={(event) => set('acceptsNonInstant', event.target.checked)}
              />
              <span>{settlementCopy.t('consentLabel')}</span>
            </label>
          ) : null}
          {shown('methods') ? <small className="error-text">{shown('methods')}</small> : null}
        </div>
        <label className="field">
          <span>{t('fieldTerms')}</span>
          <textarea
            value={values.terms}
            maxLength={4100}
            onChange={(event) => set('terms', event.target.value)}
            aria-invalid={Boolean(shown('terms'))}
          />
          {shown('terms') ? <small className="error-text">{shown('terms')}</small> : null}
        </label>
      </fieldset>
      {mode === 'edit' ? (
        <PayDetails
          values={[
            [
              t('formEditTitle'),
              changed.length === 0
                ? t('noChanges')
                : t('changedFields', { fields: changed.map((field) => t(FIELD_LABEL[field])).join(', ') }),
            ],
          ]}
        />
      ) : null}
      <Button type="submit" variant="primary" disabled={!complete || !onReview} data-testid="offer-submit">
        {complete ? (mode === 'edit' ? t('formSave') : t('formReview')) : t('formIncomplete')}
      </Button>
    </form>
  );
}
