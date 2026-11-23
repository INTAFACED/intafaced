import { useState, type FormEvent } from 'react';
import type {
  CheckoutMethodId,
  CheckoutMethodOffer,
  CheckoutMethodRule,
  CheckoutMethods as CheckoutMethodsView,
} from '@intafaced/contracts/merchant-checkout-methods';
import { Button, Checkbox, Field } from '@intafaced/ui/lit';
import { compareDecimal } from '../../../../data/decimal';
import { useResource } from '../../../../shared/resource';
import { ServiceOffNotice } from '../../../../shared/service-off';
import type { PortalApi } from '../api';
import { imageRequestId } from '../catalog/model';
import { DateTime } from '../ui/DateTime';
import { Gate, Section } from '../volt/parts';
import { useMayChangeLook } from './CheckoutLook';
import { methodsCopy as c } from './methods-copy';

/** A method's limits as typed: strings, blank for none. Decimal text on the wire, never a number. */
type Draft = { method: CheckoutMethodId; enabled: boolean; ruleAsset: string; minAmount: string; maxAmount: string };

const AMOUNT = /^\d{1,20}(\.\d{1,18})?$/;
const ASSET = /^[A-Za-z0-9]{2,12}$/;

const draftOf = (rule: CheckoutMethodRule): Draft => ({
  method: rule.method,
  enabled: rule.enabled,
  ruleAsset: rule.ruleAsset ?? '',
  minAmount: rule.minAmount ?? '',
  maxAmount: rule.maxAmount ?? '',
});

/** What is wrong with a method's limits, in the person's words, or null. */
function limitProblem(d: Draft): string | null {
  const asset = d.ruleAsset.trim();
  const min = d.minAmount.trim();
  const max = d.maxAmount.trim();
  const positive = (v: string) => AMOUNT.test(v) && /[1-9]/.test(v);
  if (!asset && !min && !max) return null;
  if (!asset || !ASSET.test(asset)) return c.t('ruleAssetMissing');
  if (!min && !max) return c.t('ruleAmountsMissing');
  if ((min && !positive(min)) || (max && !positive(max))) return c.t('ruleAmountInvalid');
  if (min && max && compareDecimal(min, max) === 1) return c.t('ruleInverted');
  return null;
}

const ruleOf = (d: Draft): CheckoutMethodRule => {
  const blank = (v: string) => (v.trim() ? v.trim() : null);
  return {
    method: d.method,
    enabled: d.enabled,
    ruleAsset: blank(d.ruleAsset)?.toUpperCase() ?? null,
    minAmount: blank(d.minAmount),
    maxAmount: blank(d.maxAmount),
  };
};

/**
 * `/pay/checkout`, payment methods (J-merchant-04 step 7): the order the hosted checkout offers its methods in, which are
 * on, and optional limits per method. A method with no rail says what it needs and is never offered as payable. Below,
 * the preview asks the hosted page's own rule what a customer in a country paying a currency would be offered.
 */
export function CheckoutMethods({ portal, ids }: { portal: PortalApi; ids?: { methods: string; preview: string } }) {
  const { resource, reload } = useResource((s) => portal.checkoutMethods(s), 'portal:checkout-methods');
  const [note, setNote] = useState<Note | null>(null);
  return (
    <>
      <Section id={ids?.methods} title={c.t('title')} description={c.t('purpose')}>
        <Gate resource={resource} retry={reload} rows={4}>
          {(methods) => (
            <MethodsForm key={methods.version} methods={methods} portal={portal} onSaved={reload} note={note} setNote={setNote} />
          )}
        </Gate>
      </Section>
      <Section id={ids?.preview} title={c.t('previewTitle')} description={c.t('previewPurpose')}>
        <OfferPreview portal={portal} />
      </Section>
    </>
  );
}

type Note = { ok: boolean; text: string };

function MethodsForm({
  methods,
  portal,
  onSaved,
  note,
  setNote,
}: {
  methods: CheckoutMethodsView;
  portal: PortalApi;
  onSaved: () => void;
  note: Note | null;
  setNote: (note: Note | null) => void;
}) {
  const may = useMayChangeLook();
  const [drafts, setDrafts] = useState<Draft[]>(() => methods.methods.map((m) => draftOf(m.rule)));
  const [busy, setBusy] = useState(false);
  const about = new Map(methods.methods.map((m) => [m.rule.method, m]));
  const problems = drafts.map(limitProblem);
  const valid = problems.every((p) => p === null);

  const change = (index: number, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  const move = (index: number, by: -1 | 1) =>
    setDrafts((ds) => {
      const to = index + by;
      if (to < 0 || to >= ds.length) return ds;
      const next = [...ds];
      [next[index], next[to]] = [next[to]!, next[index]!];
      return next;
    });

  async function save() {
    if (!valid) return;
    setBusy(true);
    setNote(null);
    try {
      const rules = drafts.map(ruleOf);
      // The request id comes from what is saved and the version it is saved over: the same save sent again after a lost
      // answer is the same request, and the service answers with the methods it already saved.
      const requestId = await imageRequestId(new Blob([JSON.stringify({ expectedVersion: methods.version, methods: rules })]));
      const result = await portal.saveCheckoutMethods({ requestId, expectedVersion: methods.version, methods: rules });
      if (result.ok) {
        setNote({ ok: true, text: c.t('saved') });
        onSaved();
      } else {
        setNote({ ok: false, text: result.message });
        if (result.code === 'pay.checkout_methods_stale') onSaved();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="form-stack">
      <p className="lt-hint" role="status" data-testid="checkout-methods-state">
        {methods.status === 'default' ? (
          c.t('isDefault')
        ) : (
          <>
            {c.t('savedOn')} {methods.updatedAt && <DateTime value={methods.updatedAt} />}
          </>
        )}
      </p>
      {!may.allowed && (
        <p className="lt-hint" role="note">
          {c.t(may.unverified ? 'unverified' : 'noWrite')}
        </p>
      )}
      <ol aria-label={c.t('title')}>
        {drafts.map((d, i) => {
          const view = about.get(d.method);
          const label = c.t(`method_${d.method}`);
          return (
            <li key={d.method} data-method={d.method}>
              <Checkbox
                checked={d.enabled}
                disabled={!may.allowed || busy}
                aria-label={c.t('on', { method: label })}
                onCheckedChange={(enabled) => change(i, { enabled })}
              >
                {label}
              </Checkbox>
              <div className="lt-actions">
                <Button
                  tone="secondary"
                  aria-label={c.t('up', { method: label })}
                  disabled={!may.allowed || busy || i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </Button>
                <Button
                  tone="secondary"
                  aria-label={c.t('down', { method: label })}
                  disabled={!may.allowed || busy || i === drafts.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </Button>
              </div>
              <p className="lt-hint">{c.t(view?.currencies === 'crypto' ? 'forCrypto' : 'forFiat')}</p>
              {view?.connection.state === 'not_connected' ? (
                <ServiceOffNotice code={view.connection.notice} action={label} role="note" />
              ) : (
                <p data-testid={`method-available-${d.method}`}>{c.t('available')}</p>
              )}
              <fieldset>
                <legend className="lt-hint">{c.t('limits', { method: label })}</legend>
                <div>
                  <Field
                    label={c.t('ruleAsset')}
                    value={d.ruleAsset}
                    maxLength={12}
                    disabled={!may.allowed || busy}
                    onChange={(e) => change(i, { ruleAsset: e.target.value })}
                  />
                  <Field
                    label={c.t('minAmount')}
                    inputMode="decimal"
                    value={d.minAmount}
                    disabled={!may.allowed || busy}
                    onChange={(e) => change(i, { minAmount: e.target.value })}
                  />
                  <Field
                    label={c.t('maxAmount')}
                    inputMode="decimal"
                    value={d.maxAmount}
                    disabled={!may.allowed || busy}
                    onChange={(e) => change(i, { maxAmount: e.target.value })}
                  />
                </div>
                <p className="lt-hint">{problems[i] ? <strong>{problems[i]}</strong> : c.t('limitsHint')}</p>
              </fieldset>
            </li>
          );
        })}
      </ol>
      {note && (
        <p className="lt-hint" role={note.ok ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      <div className="lt-actions">
        <Button tone="primary" disabled={!may.allowed || !valid || busy} onClick={() => void save()}>
          {busy ? c.t('saving') : c.t('save')}
        </Button>
      </div>
    </div>
  );
}

function OfferPreview({ portal }: { portal: PortalApi }) {
  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ ok: true; offer: CheckoutMethodOffer } | { ok: false; text: string } | null>(null);
  const countryOk = /^[A-Za-z]{2}$/.test(country.trim());
  const currencyOk = ASSET.test(currency.trim());
  const amountOk = amount.trim() === '' || (AMOUNT.test(amount.trim()) && /[1-9]/.test(amount));

  async function check(event: FormEvent) {
    event.preventDefault();
    if (!countryOk || !currencyOk || !amountOk) return;
    setBusy(true);
    try {
      const result = await portal.previewCheckoutMethods({
        country: country.trim(),
        currency: currency.trim(),
        ...(amount.trim() ? { amount: amount.trim() } : {}),
      });
      setAnswer(result.ok ? { ok: true, offer: result.data } : { ok: false, text: result.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form data-testid="form-stack" onSubmit={(e) => void check(e)}>
      <div>
        <Field
          label={c.t('country')}
          hint={c.t('countryHint')}
          value={country}
          maxLength={2}
          onChange={(e) => setCountry(e.target.value)}
        />
        <Field
          label={c.t('currency')}
          hint={c.t('currencyHint')}
          value={currency}
          maxLength={12}
          onChange={(e) => setCurrency(e.target.value)}
        />
        <Field
          label={c.t('amount')}
          hint={c.t('amountHint')}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={amountOk ? undefined : c.t('ruleAmountInvalid')}
        />
      </div>
      <div className="lt-actions">
        <Button type="submit" tone="secondary" disabled={busy || !countryOk || !currencyOk || !amountOk}>
          {busy ? c.t('checking') : c.t('check')}
        </Button>
      </div>
      {answer && !answer.ok && (
        <p className="lt-hint" role="alert">
          {answer.text}
        </p>
      )}
      {answer?.ok && (
        <div data-testid="checkout-methods-offer" aria-live="polite">
          <h4>{c.t('offered')}</h4>
          {answer.offer.offered.length === 0 ? (
            <p className="lt-hint">{c.t('nothingOffered')}</p>
          ) : (
            <ol>
              {answer.offer.offered.map((o) => (
                <li key={o.method} data-method={o.method}>
                  <strong>{c.t(`method_${o.method}`)}</strong>
                  {o.connection.state === 'not_connected' ? (
                    <ServiceOffNotice code={o.connection.notice} action={c.t(`method_${o.method}`)} role="note" />
                  ) : (
                    <p>{c.t('available')}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {answer.offer.leftOut.length > 0 && (
            <>
              <h4>{c.t('leftOut')}</h4>
              <ul>
                {answer.offer.leftOut.map((l) => (
                  <li key={l.method} data-method={l.method}>
                    {c.t(`method_${l.method}`)}: {c.t(`why_${l.reason}`)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </form>
  );
}
