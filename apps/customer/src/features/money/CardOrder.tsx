import { useMemo, useState, type FormEvent } from 'react';
import { Button, Field, Loading } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session/session';
import { countryOptions } from '../public/sign-up';
import { useBankRead } from './components';
import { bankWrites } from './contracts';
import { DepthPanel } from './DepthParts';
import { cardOrderCopy } from './card-order-copy';
import { Refusal } from './CardJourney';
import './bank-depth.css';

/**
 * `/bank/cards/new` (J-bank-13 #1 to #3; BK-cissue-01 to -03): which cards the bank offers where the person lives and why
 * not, how many they may hold, the cardholder terms to accept, then a virtual card (optionally single-use) or a physical
 * card with a design, a delivery speed and an address. Every value is the bank's (`cards.catalogue`); the order is
 * checked again there (`cards.order`), so nothing on this page is a promise.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const DECIMAL = /^\d+(\.\d{1,18})?$/;
const ASSET = 'USDT';

export function CardOrderRoom() {
  const { t } = cardOrderCopy.useCopy();
  const { api } = useSession();
  const countries = useMemo(() => countryOptions('en'), []);
  const nameOf = (code: string) => countries.find((c) => c.code === code)?.name ?? code;
  const [country, setCountry] = useState('DE');
  const catalogue = useBankRead('cards.catalogue', { country });
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [cardType, setCardType] = useState<'virtual' | 'physical'>('virtual');
  const [singleUse, setSingleUse] = useState(false);
  const [limit, setLimit] = useState('');
  const [design, setDesign] = useState<string | null>(null);
  const [speed, setSpeed] = useState<string | null>(null);
  const [address, setAddress] = useState({ name: '', line1: '', line2: '', city: '', postalCode: '', country: '' });
  // One id per order the person is making: a retry after a lost answer is the same card, never a second one. A new id
  // is taken only once the bank has answered with the card.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<{ id: string; text: string; simulated: boolean } | null>(null);

  if (catalogue.resource.status === 'loading') return <Loading />;
  if (catalogue.resource.status === 'failed') {
    return (
      <div className="bd-stack">
        <Refusal failure={catalogue.resource.failure} />
        <Button variant="ghost" onClick={catalogue.reload}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  const c = catalogue.resource.data;
  const accepted = c.terms.acceptance;
  const product = (type: 'virtual' | 'physical') => c.products.find((p) => p.type === type);
  const chosenDesign = design ?? c.designs[0]?.id ?? null;
  const chosenSpeed = speed ?? c.speeds[0]?.speed ?? null;
  const deliverTo = address.country || c.deliveryCountries[0] || '';
  const addressOk = !!(address.name.trim() && address.line1.trim() && address.city.trim() && address.postalCode.trim());
  const blocker = !c.eligible
    ? t('needEligible')
    : !accepted
      ? t('needTerms')
      : !DECIMAL.test(limit) || /^0+(\.0+)?$/.test(limit)
        ? t('needLimit')
        : cardType === 'physical' && !addressOk
          ? t('needAddress')
          : null;

  async function accept() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const done = await api.mutate(
      'bank',
      'cards.acceptTerms',
      { termsVersion: c.terms.version, textHash: c.terms.textHash },
      bankWrites['cards.acceptTerms'],
    );
    setBusy(false);
    if (!done.ok) return setFailure(done);
    catalogue.reload();
  }

  async function order(event: FormEvent) {
    event.preventDefault();
    if (busy || blocker) return;
    setBusy(true);
    setFailure(null);
    const physical = cardType === 'physical';
    const input = {
      cardId: requestId,
      country,
      termsVersion: c.terms.version,
      assetId: ASSET,
      perAuthorizationLimit: limit,
      cardType,
      ...(physical
        ? {
            designId: chosenDesign,
            deliverySpeed: chosenSpeed,
            shippingAddress: {
              name: address.name.trim(),
              line1: address.line1.trim(),
              ...(address.line2.trim() ? { line2: address.line2.trim() } : {}),
              city: address.city.trim(),
              postalCode: address.postalCode.trim(),
              country: deliverTo,
            },
          }
        : singleUse
          ? { usesAllowed: 1 }
          : {}),
    };
    const done = await api.mutate('bank', 'cards.order', input, bankWrites['cards.order']);
    setBusy(false);
    if (!done.ok) return setFailure(done);
    const card = done.data;
    const text = physical
      ? t('orderedPhysical', { tail: card.panTail })
      : card.usesAllowed === 1
        ? t('issuedSingle', { tail: card.panTail })
        : t('issuedVirtual', { tail: card.panTail });
    setResult({ id: card.id, text, simulated: card.simulated });
    setRequestId(crypto.randomUUID());
    setLimit('');
    setSingleUse(false);
    catalogue.reload();
  }

  const speedName = (s: string) => (s === 'express' ? t('express') : s === 'signed' ? t('signed') : t('standard'));
  return (
    <div className="bd-stack">
      <h1>{t('title')}</h1>
      <p className="muted">{t('description')}</p>
      <a className="text-link" href="/bank/cards">
        {t('back')}
      </a>
      <DepthPanel title={t('programmeTitle')}>
        <p data-testid="card-programme" data-simulated={String(c.programme.simulated)}>
          {c.programme.id === 'none'
            ? t('noIssuer')
            : c.programme.simulated
              ? t('simulation')
              : t('live', { name: c.programme.displayName })}
        </p>
      </DepthPanel>
      <DepthPanel title={t('productsTitle')}>
        <ul data-testid="card-products">
          <li data-testid="card-product-virtual">
            {t('virtualProduct')} · {t('network', { network: c.network })}
          </li>
          <li data-testid="card-product-physical">
            {t('physicalProduct')} · {t('network', { network: c.network })}
          </li>
        </ul>
        <p className="money-caption">{t('feeNotSet')}</p>
      </DepthPanel>
      <DepthPanel title={t('eligibilityTitle')}>
        <label className="field">
          <span>{t('countryLabel')}</span>
          <select value={country} onChange={(event) => setCountry(event.target.value)}>
            {countries.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <p data-testid="card-eligibility" data-eligible={c.eligible ? 'yes' : 'no'} data-code={c.reason ?? ''} role="status">
          {c.eligible ? t('eligible', { country: nameOf(c.country) }) : t('notEligible', { country: nameOf(c.country) })}
        </p>
      </DepthPanel>
      <DepthPanel title={t('limitsTitle')}>
        <ul data-testid="card-count-limit">
          <li>{t('virtualLimit', { held: String(product('virtual')?.held ?? 0), limit: String(product('virtual')?.limit ?? 0) })}</li>
          <li>{t('physicalLimit', { held: String(product('physical')?.held ?? 0), limit: String(product('physical')?.limit ?? 0) })}</li>
        </ul>
      </DepthPanel>
      <DepthPanel title={t('termsTitle')}>
        <div data-testid="card-terms" className="form-stack">
          <p className="money-caption">{t('termsVersion', { version: c.terms.version })}</p>
          <p>{c.terms.text}</p>
          {accepted ? (
            <p role="status">
              {t('accepted', {
                version: accepted.version,
                date: new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(
                  new Date(accepted.acceptedAt),
                ),
              })}
            </p>
          ) : (
            <>
              <label className="choice">
                <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} /> {t('acceptLabel')}
              </label>
              <Button disabled={!checked || busy} onClick={() => void accept()}>
                {t('accept')}
              </Button>
            </>
          )}
        </div>
      </DepthPanel>
      <DepthPanel title={t('orderTitle')}>
        <form className="form-stack" onSubmit={order} noValidate>
          <fieldset>
            {(['virtual', 'physical'] as const).map((type) => (
              <label key={type} className="choice">
                <input type="radio" name="card-type" checked={cardType === type} onChange={() => setCardType(type)} /> {t(type)}
              </label>
            ))}
          </fieldset>
          <Field
            label={t('limit', { asset: ASSET })}
            inputMode="decimal"
            value={limit}
            onChange={(event) => setLimit(event.target.value.trim())}
          />
          {cardType === 'virtual' ? (
            <label className="choice">
              <input type="checkbox" checked={singleUse} onChange={(event) => setSingleUse(event.target.checked)} /> {t('singleUse')}
            </label>
          ) : (
            <>
              <div role="radiogroup" aria-label={t('design')}>
                <strong>{t('design')}</strong>
                {c.designs.map((d) => (
                  <label key={d.id} className="choice">
                    <input type="radio" name="card-design" checked={chosenDesign === d.id} onChange={() => setDesign(d.id)} /> {d.name}
                  </label>
                ))}
              </div>
              <div role="radiogroup" aria-label={t('speed')}>
                <strong>{t('speed')}</strong>
                {c.speeds.map((s) => (
                  <label key={s.speed} className="choice">
                    <input type="radio" name="card-speed" checked={chosenSpeed === s.speed} onChange={() => setSpeed(s.speed)} />{' '}
                    {t('speedLine', { speed: speedName(s.speed), days: String(s.days) })}
                  </label>
                ))}
              </div>
              <Field label={t('name')} value={address.name} onChange={(event) => setAddress({ ...address, name: event.target.value })} />
              <Field label={t('line1')} value={address.line1} onChange={(event) => setAddress({ ...address, line1: event.target.value })} />
              <Field label={t('line2')} value={address.line2} onChange={(event) => setAddress({ ...address, line2: event.target.value })} />
              <Field label={t('city')} value={address.city} onChange={(event) => setAddress({ ...address, city: event.target.value })} />
              <Field
                label={t('postalCode')}
                value={address.postalCode}
                onChange={(event) => setAddress({ ...address, postalCode: event.target.value })}
              />
              <label className="field">
                <span>{t('deliveryCountry')}</span>
                <select value={deliverTo} onChange={(event) => setAddress({ ...address, country: event.target.value })}>
                  {c.deliveryCountries.map((code) => (
                    <option key={code} value={code}>
                      {nameOf(code)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="money-caption" data-code="hardware">
                {t('hardware')}
              </p>
            </>
          )}
          <Button type="submit" disabled={busy || blocker !== null}>
            {cardType === 'physical' ? t('orderPhysical') : t('issueVirtual')}
          </Button>
          {blocker && <p className="money-caption">{blocker}</p>}
          {failure && <Refusal failure={failure} />}
        </form>
        {result && (
          <p role="status" data-testid="card-order-result" data-card-id={result.id}>
            {result.text} {result.simulated ? t('simulation') : null}
          </p>
        )}
      </DepthPanel>
    </div>
  );
}
