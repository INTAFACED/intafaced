import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AmountInput, Button, confirmWithStepUp, refusalCopy, useSession } from './deps';
import type { ApiResult } from './deps';
import { payCopy } from './copy';
import { personalCopy } from './personal-copy';
import { globalCopy } from './global-copy';
import { Reason, sourceLabel, Steps, useSources } from './journey';
import { createGlobalApi } from './global-api';
import {
  amountProblem,
  askedField,
  destinationsFrom,
  progressOf,
  recipientKey,
  type ComplianceField,
  type Corridor,
  proofProblem,
  type GlobalHold,
  type GlobalQuote,
  type GlobalSend,
  type Recipient,
  type SendDraft,
} from './global-model';

type Load<T> = { state: 'loading' } | { state: 'failed'; code: string | undefined; message: string } | { state: 'ready'; data: T };
const loading = { state: 'loading' } as const;
const settle = <T,>(result: ApiResult<T>): Load<T> =>
  result.ok ? { state: 'ready', data: result.data } : { state: 'failed', code: result.code, message: result.message };

type Say = { title: string; body: string };
const sayFor = (code: string | undefined, message: string): Say => {
  if (!code) return { title: message, body: '' };
  const words = refusalCopy(code);
  return { title: words.title, body: words.body };
};

const passkeyKey: Record<string, 'noPasskey' | 'codeBad' | 'passkeyStopped' | 'passkeyFailed' | 'passkeyUnavailable'> = {
  'stepUp.no_passkey': 'noPasskey',
  'auth.webauthn_not_enrolled': 'noPasskey',
  'auth.mfa_invalid': 'codeBad',
  'auth.webauthn_invalid': 'passkeyFailed',
  'portal.passkey_stopped': 'passkeyStopped',
  'portal.passkey_unavailable': 'passkeyUnavailable',
  'portal.passkey_failed': 'passkeyFailed',
  'portal.passkey_unreadable': 'passkeyFailed',
};

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });

/**
 * The banner on a held send: what the team asked for and, when it asked for a file, the upload. It says nothing about
 * why the send was held, and it offers an upload only inside the limits the service published.
 */
function HoldPanel({ sendId, global }: { sendId: string; global: ReturnType<typeof createGlobalApi> }) {
  const { t: g } = globalCopy.useCopy();
  const [hold, setHold] = useState<Load<GlobalHold>>(loading);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Say | string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void global.hold(sendId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setHold(settle(result));
    });
    return () => controller.abort();
  }, [global, sendId]);

  async function choose(input: HTMLInputElement, limits: GlobalHold['proofLimits']) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const why = proofProblem(file, limits);
    if (why) {
      setProblem(
        why === 'noLimits'
          ? g('holdOff')
          : sayFor(why === 'type' ? 'bank.proof_type_not_allowed' : why === 'size' ? 'bank.proof_too_large' : 'bank.proof_invalid', ''),
      );
      return;
    }
    setBusy(true);
    setProblem(null);
    let contentBase64: string;
    try {
      contentBase64 = await toBase64(file);
    } catch {
      setBusy(false);
      setProblem(g('holdFileInvalid'));
      return;
    }
    const result = await global.uploadProof({ id: sendId, name: file.name, type: file.type.toLowerCase(), contentBase64 });
    setBusy(false);
    if (result.ok) setHold({ state: 'ready', data: result.data });
    else {
      setProblem(sayFor(result.code, result.message));
      if (result.code === 'bank.proof_already_uploaded' || result.code === 'bank.proof_not_requested') {
        const fresh = await global.hold(sendId);
        if (fresh.ok) setHold({ state: 'ready', data: fresh.data });
      }
    }
  }

  const data = hold.state === 'ready' ? hold.data : null;
  const shown = typeof problem === 'string' ? { title: problem, body: '' } : problem;
  return (
    <div className="pay-block" role="status" data-testid="global-hold">
      <h4 className="pay-section-title">{g('holdTitle')}</h4>
      <p className="pay-hint">{g('holdBody')}</p>
      {hold.state === 'failed' ? <p className="pay-hint">{sayFor(hold.code, hold.message).title}</p> : null}
      {data?.infoRequest ? (
        <p data-testid="global-hold-ask">
          {g('holdAsk')} {data.infoRequest}
        </p>
      ) : null}
      {data && data.state === 'under_review' && data.proofUploaded ? <p className="pay-hint">{g('holdUploaded')}</p> : null}
      {data && data.state === 'requested' && data.infoRequest && !data.proofUploaded ? (
        data.proofLimits ? (
          <label className="pay-field__label">
            {busy ? g('holdUploading') : g('holdUpload')}
            <input
              type="file"
              disabled={busy}
              accept={data.proofLimits.allowedTypes.join(',')}
              onChange={(event) => void choose(event.currentTarget, data.proofLimits)}
            />
          </label>
        ) : (
          <p className="pay-hint">{g('holdOff')}</p>
        )
      ) : null}
      {shown ? (
        <p className="pay-problem" role="alert">
          {shown.title} {shown.body}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Send globally (/pay/global), on the service's own answers: the destinations it publishes, the recipients you saved, a
 * quote it gives, and a send confirmed with a passkey or an authenticator code that covers exactly that send. Where the
 * payout partner, the corridor list or the rate source is not connected, the service refuses with a typed code and the
 * screen shows its words; it never shows a made-up rate, fee, limit or arrival.
 */
export function GlobalCard() {
  const { t } = personalCopy.useCopy();
  const { t: g } = globalCopy.useCopy();
  const { api, userId } = useSession();
  const { sources } = useSources();
  const global = useMemo(() => createGlobalApi(api), [api]);

  const [corridors, setCorridors] = useState<Load<Corridor[]>>(loading);
  const [recipients, setRecipients] = useState<Load<Recipient[]>>(loading);
  const [history, setHistory] = useState<Load<GlobalSend[]>>(loading);
  const loadHistory = useCallback(
    (signal?: AbortSignal) =>
      global.sends(signal).then((result) => {
        if (!signal?.aborted) setHistory(settle(result.ok ? { ok: true, data: result.data.items } : result));
      }),
    [global],
  );
  const loadRecipients = useCallback(
    (signal?: AbortSignal) =>
      global.recipients(signal).then((result) => {
        if (!signal?.aborted) setRecipients(settle(result));
      }),
    [global],
  );
  useEffect(() => {
    const controller = new AbortController();
    void global.corridors(controller.signal).then((result) => {
      if (!controller.signal.aborted) setCorridors(settle(result));
    });
    void loadRecipients(controller.signal);
    void loadHistory(controller.signal);
    return () => controller.abort();
  }, [global, loadRecipients, loadHistory]);

  const destinations = useMemo(() => (corridors.state === 'ready' ? destinationsFrom(corridors.data) : []), [corridors]);
  const [destKey, setDestKey] = useState('');
  const destination = destinations.find((row) => row.key === destKey) ?? null;
  const [recipientId, setRecipientId] = useState('');
  const saved = recipients.state === 'ready' ? recipients.data : [];
  const recipient = saved.find((row) => row.id === recipientId) ?? null;
  const [amount, setAmount] = useState('');
  const [sourceId, setSourceId] = useState('');
  const source = sources.find((row) => row.id === sourceId) ?? sources[0] ?? null;

  // New recipient
  const [name, setName] = useState('');
  const [account, setAccount] = useState('');
  const [bic, setBic] = useState('');
  const [label, setLabel] = useState('');
  const [recipientNote, setRecipientNote] = useState<string | null>(null);
  const [recipientProblem, setRecipientProblem] = useState<Say | null>(null);
  const [recipientBusy, setRecipientBusy] = useState(false);

  // Quote, kept only for the figures it was asked for
  const [quote, setQuote] = useState<{ for: string; data: GlobalQuote } | { for: string; failed: Say } | 'busy' | null>(null);
  const quoteKey = `${source?.id ?? ''}|${destination?.currency ?? ''}|${amount}`;
  const liveQuote = quote && quote !== 'busy' && quote.for === quoteKey && 'data' in quote ? quote.data : null;
  const quoteFailed = quote && quote !== 'busy' && quote.for === quoteKey && 'failed' in quote ? quote.failed : null;

  const [asked, setAsked] = useState<readonly ComplianceField[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [review, setReview] = useState<SendDraft | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'code' | 'passkey' | 'send' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<Say | null>(null);
  // True after an answer we could not read: the same send may have gone through, so only a confirm of it is allowed.
  const [unsettled, setUnsettled] = useState(false);
  const [sent, setSent] = useState<GlobalSend | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const problemWith = amount === '' ? null : amountProblem(amount, destination?.corridor ?? null);
  const need =
    corridors.state !== 'ready'
      ? null
      : !destination
        ? g('needDestination')
        : !recipient
          ? g('needRecipient')
          : !source
            ? g('needSource')
            : amountProblem(amount, destination.corridor) === 'empty'
              ? g('needAmount')
              : problemWith === 'belowMinimum'
                ? g('belowMinimum')
                : problemWith === 'aboveMaximum'
                  ? g('aboveMaximum')
                  : null;

  async function getQuote() {
    if (need || !source || !destination) return;
    const asked = quoteKey;
    setQuote('busy');
    const result = await global.quote({ asset: source.asset, amount, toCurrency: destination.currency });
    if (!alive.current) return;
    setQuote(result.ok ? { for: asked, data: result.data } : { for: asked, failed: sayFor(result.code, result.message) });
  }

  async function checkAndSaveRecipient(event: FormEvent) {
    event.preventDefault();
    if (recipientBusy || !destination) return;
    setRecipientBusy(true);
    setRecipientProblem(null);
    setRecipientNote(null);
    const country = destination.country;
    const checked = await global.validate({ account, ...(bic.trim() ? { bic: bic.trim() } : {}) });
    if (!alive.current) return;
    if (!checked.ok) {
      setRecipientBusy(false);
      return setRecipientProblem(sayFor(checked.code, checked.message));
    }
    if (checked.data.format === 'invalid' || !checked.data.normalized) {
      setRecipientBusy(false);
      return setRecipientProblem({ title: g('recipientFormatBad'), body: '' });
    }
    const added = await global.addRecipient({
      idempotencyKey: recipientKey(userId ?? '', country, checked.data.normalized),
      name: name.trim(),
      account,
      country,
      ...(bic.trim() ? { bic: bic.trim() } : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
    });
    if (!alive.current) return;
    setRecipientBusy(false);
    if (!added.ok) return setRecipientProblem(sayFor(added.code, added.message));
    setRecipientNote(g('recipientSaved'));
    setName('');
    setAccount('');
    setBic('');
    setLabel('');
    setRecipientId(added.data.id);
    void loadRecipients();
  }

  async function removeRecipient(row: Recipient) {
    const removed = await global.removeRecipient({ recipientId: row.id, idempotencyKey: `global-recipient-remove:${row.id}` });
    if (!alive.current) return;
    if (!removed.ok) return setRecipientProblem(sayFor(removed.code, removed.message));
    setRecipientNote(g('recipientRemoved'));
    if (recipientId === row.id) setRecipientId('');
    void loadRecipients();
  }

  function startReview(event: FormEvent) {
    event.preventDefault();
    if (need || !source || !destination || !recipient) return;
    if (!liveQuote) return setFailure({ title: g('needQuote'), body: '' });
    if (Date.parse(liveQuote.validUntil) <= Date.now()) return setFailure({ title: g('quoteExpired'), body: '' });
    setFailure(null);
    setProblem(null);
    setReview({
      // Made once for this review and kept until it closes, so every confirm inside it is the same send.
      idempotencyKey: `global-send:${crypto.randomUUID()}`,
      fromSpaceId: source.id,
      assetId: source.asset,
      amount,
      toCurrency: destination.currency.toUpperCase(),
      recipientId: recipient.id,
      country: destination.country.toUpperCase(),
      deliveryMethod: destination.method.trim(),
      compliance: fields,
    });
  }

  async function confirm(how: 'code' | 'passkey') {
    if (!review || busy) return;
    if (how === 'code' && !/^\d{6}$/.test(code.trim())) return setProblem(g('codeShort'));
    if (!unsettled && (!liveQuote || Date.parse(liveQuote.validUntil) <= Date.now())) {
      setReview(null);
      setProblem(null);
      return setFailure({ title: g('quoteExpired'), body: '' });
    }
    // The fields the service asked for may have been filled in since this review began; the confirmation must cover them.
    const draft: SendDraft = { ...review, compliance: fields };
    setBusy(how);
    setProblem(null);
    setFailure(null);
    const approved = await confirmWithStepUp(
      api,
      global.stepUpRequest(draft),
      how === 'code' ? { totpCode: code.trim() } : { passkey: true },
    );
    if (!alive.current) return;
    if (!approved.ok) {
      setBusy(null);
      const key = approved.code ? passkeyKey[approved.code] : undefined;
      return setProblem(key ? g(key) : approved.code ? g('confirmFailed') : approved.message || g('confirmFailed'));
    }
    setBusy('send');
    const result = await global.send(draft, approved.data.stepUpApprovalId);
    if (!alive.current) return;
    setBusy(null);
    setCode('');
    const unknown = !result.ok && (result.reason === 'uncertain' || result.code === 'bank.global_outcome_unknown');
    setUnsettled(unknown);
    if (result.ok) {
      setSent(result.data);
      setReview(null);
      setFailure(null);
      setQuote(null);
      setAsked([]);
      setFields({});
      setAmount('');
      void loadHistory();
      return;
    }
    const field = askedField(result.code);
    if (field) {
      // The service asks for one more field. The confirmation was spent, so the person fills it in and confirms again.
      setAsked((now) => (now.includes(field) ? now : [...now, field]));
      setReview(null);
    }
    if (unknown) {
      // Keep the review and its key: confirming again replays the same send and can never make a second one.
      setProblem(g('uncertain'));
      return;
    }
    setFailure(sayFor(result.code, result.message));
    if (!field) setReview(null);
  }

  const askedLabel: Record<ComplianceField, string> = {
    purpose: g('askedPurpose'),
    sourceOfFunds: g('askedSource'),
    reference: g('askedReference'),
  };
  const statusWord = (status: GlobalSend['status']) =>
    g(
      status === 'submitted'
        ? 'statusSubmitted'
        : status === 'held'
          ? 'statusHeld'
          : status === 'sent'
            ? 'statusSent'
            : status === 'on_the_way'
              ? 'statusOnTheWay'
              : status === 'arrived'
                ? 'statusArrived'
                : 'statusFailed',
    );
  const unavailable = corridors.state === 'failed' ? sayFor(corridors.code, corridors.message) : null;
  const trackSteps = [g('statusSent'), g('statusOnTheWay'), g('statusArrived')];
  const limits = destination?.corridor;

  const ready = corridors.state === 'ready';
  const locked = !ready || busy !== null;
  const stepUpOpen = review !== null;
  return (
    <div className="pay-body" data-testid="global-card">
      {unavailable ? <Reason title={unavailable.title}>{unavailable.body}</Reason> : null}
      <Steps
        items={[
          t('globalStepDestination'),
          t('globalStepRecipient'),
          t('globalStepAmount'),
          t('globalStepQuote'),
          t('globalStepReview'),
          t('globalStepTrack'),
        ]}
      />
      {corridors.state === 'loading' ? <p className="pay-hint">{g('loading')}</p> : null}
      {sent ? (
        <div className="pay-block" role="status" data-testid="global-sent">
          <h3 className="pay-section-title">{g('sentTitle')}</h3>
          <p className="pay-hint">{g('sentBody')}</p>
          <Button variant="secondary" onClick={() => setSent(null)}>
            {g('sendAnother')}
          </Button>
        </div>
      ) : null}
      <form className="pay-body" noValidate onSubmit={startReview}>
        <fieldset className="pay-fieldset" disabled={locked || stepUpOpen}>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="global-currency">
              {g('destination')}
            </label>
            <select
              id="global-currency"
              className="pay-text"
              value={destKey}
              onChange={(event) => {
                setDestKey(event.target.value);
                setRecipientId('');
              }}
            >
              <option value="">{g('destinationPick')}</option>
              {destinations.map((row) => (
                <option key={row.key} value={row.key}>
                  {g('destinationLine', { country: row.country, currency: row.currency, method: row.method })}
                </option>
              ))}
            </select>
            {limits ? (
              <p className="pay-hint" data-testid="global-limits">
                {[
                  limits.minAmount ? g('destinationMin', { min: limits.minAmount }) : null,
                  limits.maxAmount ? g('destinationMax', { max: limits.maxAmount }) : null,
                  limits.cutOffTime ? g('destinationCutOff', { cutOff: limits.cutOffTime }) : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
              </p>
            ) : null}
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="global-recipient">
              {g('recipient')}
            </label>
            <select id="global-recipient" className="pay-text" value={recipientId} onChange={(event) => setRecipientId(event.target.value)}>
              <option value="">{recipients.state === 'loading' ? g('loading') : g('recipientPick')}</option>
              {saved
                .filter((row) => !destination || row.country === destination.country)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label ? `${row.label} · ` : ''}
                    {row.name} · {row.account}
                  </option>
                ))}
            </select>
            {recipients.state === 'failed' ? <p className="pay-problem">{sayFor(recipients.code, recipients.message).title}</p> : null}
            {recipients.state === 'ready' && saved.length === 0 ? <p className="pay-hint">{g('recipientNone')}</p> : null}
            {recipient ? (
              <Button type="button" variant="ghost" onClick={() => void removeRecipient(recipient)}>
                {g('recipientRemove')}
              </Button>
            ) : null}
          </div>
        </fieldset>
        <fieldset className="pay-fieldset" disabled={locked || stepUpOpen || !destination}>
          <h3 className="pay-section-title">{g('recipientNew')}</h3>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="global-name">
              {t('recipientName')}
            </label>
            <input
              id="global-name"
              className="pay-text"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="global-account">
              {t('recipientAccount')}
            </label>
            <input
              id="global-account"
              className="pay-text"
              type="text"
              autoComplete="off"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="global-bank">
              {t('recipientBankCode')}
            </label>
            <input
              id="global-bank"
              className="pay-text"
              type="text"
              autoComplete="off"
              value={bic}
              onChange={(e) => setBic(e.target.value)}
            />
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="global-label">
              {g('recipientLabel')}
            </label>
            <input
              id="global-label"
              className="pay-text"
              type="text"
              autoComplete="off"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            data-testid="global-recipient-save"
            disabled={recipientBusy || !name.trim() || !account.trim()}
            onClick={(event) => void checkAndSaveRecipient(event)}
          >
            {recipientBusy ? g('confirming') : g('recipientSave')}
          </Button>
          {recipientNote ? (
            <p className="pay-hint" role="status">
              {recipientNote}
            </p>
          ) : null}
          {recipientProblem ? (
            <p className="pay-problem" role="alert">
              {recipientProblem.title} {recipientProblem.body}
            </p>
          ) : null}
        </fieldset>
        <fieldset className="pay-fieldset" disabled={locked || stepUpOpen}>
          <div className="pay-field">
            <span className="pay-field__label">{g('amountLabel')}</span>
            <AmountInput aria-label={g('amountLabel')} value={amount} onValueChange={setAmount} precision={18} placeholder="0" />
            <select
              className="pay-text"
              aria-label={payCopy.t('Asset to send')}
              value={source?.id ?? ''}
              onChange={(event) => setSourceId(event.target.value)}
            >
              {sources.length === 0 ? <option value="">{g('noSource')}</option> : null}
              {sources.map((row) => (
                <option key={row.id} value={row.id}>
                  {sourceLabel(row)}
                </option>
              ))}
            </select>
          </div>
        </fieldset>
        <div>
          <h3 className="pay-section-title">{t('quote')}</h3>
          <dl className="pay-quote" data-testid="global-quote">
            <div>
              <dt>{t('quoteRate')}</dt>
              <dd>{liveQuote ? liveQuote.rate : '—'}</dd>
            </div>
            <div>
              <dt>{t('quoteFee')}</dt>
              <dd>{liveQuote ? g('quoteFee', { fee: liveQuote.fee, asset: liveQuote.feeAsset }) : '—'}</dd>
            </div>
            <div>
              <dt>{t('quoteReceive')}</dt>
              <dd>{liveQuote && destination ? `${liveQuote.receiveAmount} ${destination.currency}` : '—'}</dd>
            </div>
            <div>
              <dt>{t('quoteArrives')}</dt>
              <dd>{liveQuote ? liveQuote.eta : '—'}</dd>
            </div>
          </dl>
          {liveQuote ? (
            <p className="pay-hint">{g('quoteValidUntil', { time: liveQuote.validUntil })}</p>
          ) : (
            <p className="pay-hint">{t('quoteNone')}</p>
          )}
          {quoteFailed ? (
            <p className="pay-problem" role="alert" data-testid="global-quote-refused">
              {quoteFailed.title} {quoteFailed.body}
            </p>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            data-testid="global-get-quote"
            disabled={locked || stepUpOpen || need !== null || quote === 'busy'}
            onClick={() => void getQuote()}
          >
            {quote === 'busy' ? g('quoting') : g('getQuote')}
          </Button>
        </div>
        {asked.length > 0 ? (
          <fieldset className="pay-fieldset" disabled={stepUpOpen}>
            <p className="pay-hint">{g('askedHint')}</p>
            {asked.map((field) => (
              <div className="pay-field" key={field}>
                <label className="pay-field__label" htmlFor={`global-${field}`}>
                  {askedLabel[field]}
                </label>
                <input
                  id={`global-${field}`}
                  className="pay-text"
                  type="text"
                  autoComplete="off"
                  maxLength={200}
                  value={fields[field] ?? ''}
                  onChange={(event) => setFields((now) => ({ ...now, [field]: event.target.value }))}
                />
              </div>
            ))}
          </fieldset>
        ) : null}
        {need && ready ? <p className="pay-hint">{need}</p> : null}
        {failure ? (
          <p className="pay-problem" role="alert" data-testid="global-failure">
            {failure.title} {failure.body}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          size={56}
          fullWidth
          disabled={locked || stepUpOpen || need !== null}
          data-testid="global-review"
        >
          {g('review')}
        </Button>
      </form>
      {review && destination && recipient ? (
        <div className="pay-block" role="group" aria-label={g('reviewTitle')} data-testid="global-confirm">
          <h3 className="pay-section-title">{g('reviewTitle')}</h3>
          <dl className="pay-quote">
            <div>
              <dt>{g('reviewTo')}</dt>
              <dd>
                {recipient.name} · {recipient.account} · {destination.country}
              </dd>
            </div>
            <div>
              <dt>{g('reviewAmount')}</dt>
              <dd>
                {review.amount} {review.assetId}
              </dd>
            </div>
            {liveQuote ? (
              <>
                <div>
                  <dt>{g('reviewReceive')}</dt>
                  <dd>
                    {liveQuote.receiveAmount} {destination.currency}
                  </dd>
                </div>
                <div>
                  <dt>{g('reviewFee')}</dt>
                  <dd>{g('quoteFee', { fee: liveQuote.fee, asset: liveQuote.feeAsset })}</dd>
                </div>
                <div>
                  <dt>{g('reviewRate')}</dt>
                  <dd>{liveQuote.rate}</dd>
                </div>
                <div>
                  <dt>{g('reviewArrives')}</dt>
                  <dd>{liveQuote.eta}</dd>
                </div>
              </>
            ) : null}
          </dl>
          <p className="pay-hint">{g('confirmWhy')}</p>
          <Button type="button" variant="primary" disabled={busy !== null} onClick={() => void confirm('passkey')}>
            {busy === 'send' ? g('sending') : busy === 'passkey' ? g('confirming') : g('confirmPasskey')}
          </Button>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="global-code">
              {g('confirmCodeLabel')}
            </label>
            <input
              id="global-code"
              className="pay-text"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              disabled={busy !== null}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <p className="pay-hint">{g('confirmCodeHint')}</p>
          </div>
          <Button type="button" variant="secondary" disabled={busy !== null || code.length < 6} onClick={() => void confirm('code')}>
            {busy === 'code' ? g('confirming') : g('confirmCode')}
          </Button>
          {problem ? (
            <p className="pay-problem" role="alert">
              {problem}
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={busy !== null || unsettled}
            onClick={() => {
              setReview(null);
              setProblem(null);
            }}
          >
            {g('reviewBack')}
          </Button>
        </div>
      ) : null}
      <div className="pay-block">
        <h3 className="pay-section-title">{t('globalStepTrack')}</h3>
        <Steps items={trackSteps} />
      </div>
      <div className="pay-block" data-testid="global-history">
        <h3 className="pay-section-title">{t('globalHistory')}</h3>
        {history.state === 'loading' ? <p className="pay-empty">{g('loading')}</p> : null}
        {history.state === 'failed' ? <p className="pay-empty">{sayFor(history.code, history.message).title}</p> : null}
        {history.state === 'ready' && history.data.length === 0 ? <p className="pay-empty">{t('globalHistoryEmpty')}</p> : null}
        {history.state === 'ready' && history.data.length > 0 ? (
          <ul className="pay-list">
            {history.data.map((row) => (
              <li key={row.id} data-status={row.status}>
                {g('historyLine', { amount: row.amount, asset: row.assetId, currency: row.toCurrency, status: statusWord(row.status) })}
                {row.status === 'failed' ? ` — ${g('failedWhy')}` : row.status === 'held' ? null : ` (${progressOf(row.status)}/3)`}
                {row.status === 'held' ? <HoldPanel sendId={row.id} global={global} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
