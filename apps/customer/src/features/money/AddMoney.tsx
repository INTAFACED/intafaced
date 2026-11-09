import { useEffect, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { decimalSchema, parseAmount } from '../../shared/money';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { addMoneyCopy } from './add-money-copy';
import { date, funds, useBankRead } from './components';
import { addMoneyRequestSchema, type AddMoneyMethod, type AddMoneyOption, type AddMoneyRequest } from './contracts';
import { DepthPanel, Fact } from './DepthParts';
import { IncomingPayments } from './IncomingPayments';
import './bank-depth.css';

/**
 * Add money (J-bank-02): the amount, every way to pay with the fee and arrival the bank quoted (a blank reads "not set"),
 * and the request itself. A way to pay with no partner says which rail it needs and why; asking anyway keeps the request,
 * refused, in the list below, and nothing is charged or added. A way to pay a partner opens as a hosted page sends the
 * person to the page the partner answered with; coming back (`?request=<id>`), the tracker follows that request from
 * created to credited, reading the bank until it is credited. Every figure is the service's own string.
 */

type Ask = { assetId: string; amount: string; country: string };
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

const EXPIRED = 'bank.onramp_quote_expired';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How often the tracker reads the bank while a request is on its way: often at first, then slowly while it waits long. */
const TRACK_EVERY_MS = 2_000;
const TRACK_SLOW_MS = 30_000;
const TRACK_FAST_READS = 150;
/** A read that fails this many times in a row stops the tracker; the failure stays on screen with a retry. */
const TRACK_FAILURES = 3;
const FEE_NOT_KNOWN = 'bank.onramp_fee_not_known';
const STEPS = ['created', 'opened', 'pending', 'credited'] as const;
const STEP_KEYS = {
  created: 'step_created',
  opened: 'step_opened',
  pending: 'step_pending',
  credited: 'step_credited',
} as const;

const METHOD_KEYS = {
  bank_transfer: 'method_bank_transfer',
  pay_by_bank: 'method_pay_by_bank',
  card: 'method_card',
  wallet_pay: 'method_wallet_pay',
} as const;

function amountOk(value: string) {
  return decimalSchema.safeParse(value.trim()).success && parseAmount(value.trim()) > 0n;
}

function Method({ row, chosen, onChoose }: { row: AddMoneyOption; chosen: boolean; onChoose: () => void }) {
  const { t } = addMoneyCopy.useCopy();
  const quote = row.quote;
  // The partner's ramp gave no fee: the fee and the pay amount are "not known", never 0, and the way to pay is not offered.
  const feeUnknown = row.blocker === FEE_NOT_KNOWN;
  return (
    <label className={`bd-choice ${chosen ? 'bd-choice--on' : ''}`} data-testid={`method-${row.method}`}>
      <input type="radio" name="add-money-method" value={row.method} checked={chosen} onChange={onChoose} />
      <strong>{t(METHOD_KEYS[row.method])}</strong>
      <span className="money-caption">
        {t('fee')}: {quote ? funds(quote.fee, quote.payCurrency) : feeUnknown ? t('notKnown') : t('notSet')}
      </span>
      <span className="money-caption">
        {t('arrives')}: {quote?.deliveryEstimate ?? t('notSet')}
      </span>
      <span className="money-caption">
        {t('youPay')}: {quote ? funds(quote.payAmount, quote.payCurrency) : feeUnknown ? t('notKnown') : t('notSet')}
      </span>
      {quote && (
        <span className="money-caption" data-testid="method-receive">
          {t('youReceive')}: {funds(quote.amount, quote.assetId)}
        </span>
      )}
      {quote && (
        <span className="money-caption">
          {t('priceUntil')}: {date(quote.expiresAt, true)}
        </span>
      )}
      {row.standIn && (
        <small className="muted">
          {row.payStandIn ? t('standInPriced', { label: row.standIn }) : t('standIn', { label: row.standIn })}
        </small>
      )}
      {row.quote && row.payStandIn && <small className="muted">{t('payStandIn', { label: row.payStandIn })}</small>}
      {row.blocker && (
        <small className="muted">
          {feeUnknown ? t('feeNotKnown') : t('railOff', { rail: row.rail })} {t('reference', { code: row.blocker })}
        </small>
      )}
    </label>
  );
}

function Refused({ title, body, reference }: { title: string; body: string; reference: string }) {
  return (
    <div className="failure" role="status" data-testid="add-money-refused">
      <h3>{title}</h3>
      <p>{body}</p>
      <small className="muted">{reference}</small>
    </div>
  );
}

/** What asking answered: a kept request, a price that ran out before anything was kept, or another failure. */
function Answer({ outcome }: { outcome: AddMoneyRequest | Refusal }) {
  const { t } = addMoneyCopy.useCopy();
  if (!('ok' in outcome)) return <Outcome request={outcome} />;
  if (outcome.code !== EXPIRED) return <Failure result={outcome} />;
  return <Refused title={t('expiredTitle')} body={t('expiredNow')} reference={t('reference', { code: EXPIRED })} />;
}

function Outcome({ request }: { request: AddMoneyRequest }) {
  const { t } = addMoneyCopy.useCopy();
  if (request.status === 'refused') {
    const expired = request.refusalCode === EXPIRED;
    return (
      <Refused
        title={expired ? t('expiredTitle') : t('refusedTitle')}
        body={expired ? t('expiredBody') : t('refusedBody', { rail: request.rail })}
        reference={`${request.rail} · ${t('reference', { code: request.refusalCode ?? '' })}`}
      />
    );
  }
  const onramp = request.onramp;
  return (
    <div role="status" data-testid="add-money-opened">
      <h3>{t('openedTitle')}</h3>
      {onramp?.bankInstructions && (
        <dl className="bd-facts">
          <Fact label={t('payReference')}>
            <span lang="und">{onramp.bankInstructions.reference}</span>
          </Fact>
          <Fact label={t('accountName')}>
            <span lang="und">{onramp.bankInstructions.accountName}</span>
          </Fact>
          <Fact label={t('account')}>
            <span lang="und">{onramp.bankInstructions.accountRef}</span>
          </Fact>
          <Fact label={t('youPay')}>{funds(onramp.payAmount, onramp.payCurrency)}</Fact>
        </dl>
      )}
      {onramp?.hostedUrl && (
        <a className="button button--primary" href={onramp.hostedUrl} rel="noopener noreferrer">
          {t('goPay')}
        </a>
      )}
    </div>
  );
}

/**
 * Each step's state: done with its time; skipped when a later step happened but the partner never reported this one
 * (it said paid without saying the payer approved), never given a made-up time; or not yet.
 */
function stepState(request: AddMoneyRequest, step: (typeof STEPS)[number]): 'done' | 'skipped' | 'todo' {
  if (reachedAt(request, step)) return 'done';
  const later = STEPS.slice(STEPS.indexOf(step) + 1);
  return later.some((next) => reachedAt(request, next)) ? 'skipped' : 'todo';
}

/** When the request reached each step, or null while it has not. */
function reachedAt(request: AddMoneyRequest, step: (typeof STEPS)[number]): string | null {
  if (step === 'created') return request.createdAt;
  if (step === 'opened') return request.openedAt;
  if (step === 'pending') return request.pendingAt;
  return request.creditedAt;
}

/** Where one request stands, step by step, with when each happened and what was credited. */
export function TrackerSteps({ request }: { request: AddMoneyRequest }) {
  const { t } = addMoneyCopy.useCopy();
  return (
    <>
      <p className="money-caption">
        <strong>{t(METHOD_KEYS[request.method])}</strong> · <StatusWord request={request} />
      </p>
      <ol className="bd-stack">
        {STEPS.map((step) => {
          const at = reachedAt(request, step);
          const state = stepState(request, step);
          return (
            <li key={step} data-testid="tracker-step" data-step={step} data-state={state}>
              <strong>{t(STEP_KEYS[step])}</strong>{' '}
              <small className="muted">{at ? date(at, true) : state === 'skipped' ? t('stepSkipped') : t('stepNotYet')}</small>
            </li>
          );
        })}
      </ol>
      <p className="money-caption" data-testid="tracker-receive">
        {t('trackerAmount')}: <span dir="ltr">{funds(request.onramp?.amount ?? request.amount, request.assetId)}</span>
      </p>
      {request.creditedAmount && (
        <p data-testid="tracker-credited">
          <span dir="ltr">{t('creditedAmount', { amount: funds(request.creditedAmount, request.assetId) })}</span>
        </p>
      )}
    </>
  );
}

/** One request from created to credited, read from the bank until it is credited or refused. */
function Tracker({ requestId, onSettled }: { requestId: string; onSettled: () => void }) {
  const { t } = addMoneyCopy.useCopy();
  const { api } = useSession();
  const [request, setRequest] = useState<AddMoneyRequest | null>(null);
  const [failure, setFailure] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reads = 0;
    let failures = 0;
    const read = async () => {
      const result = await api.query('bank', 'addMoney.request', { requestId }, addMoneyRequestSchema);
      if (stopped) return;
      reads += 1;
      if (result.ok) {
        failures = 0;
        setRequest(result.data);
        setFailure(null);
        if (result.data.status === 'credited' || result.data.status === 'refused') {
          onSettled();
          return;
        }
      } else {
        failures += 1;
        setFailure(result);
        // A request that is not yours, or a bank that keeps refusing, is not read again on its own: retry is the person's.
        if (failures >= TRACK_FAILURES || result.code === 'bank.add_money_request_missing') return;
      }
      timer = setTimeout(() => void read(), reads < TRACK_FAST_READS ? TRACK_EVERY_MS : TRACK_SLOW_MS);
    };
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // onSettled is the parent's refresh; following a new request is what restarts the reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, requestId, attempt]);
  return (
    <DepthPanel title={t('trackerTitle')} lead={t('trackerLead')}>
      {failure && !request ? (
        <Failure result={failure} retry={() => setAttempt((n) => n + 1)} />
      ) : !request ? (
        <Loading />
      ) : (
        <div className="bd-stack" data-testid="add-money-tracker" data-status={request.status}>
          <TrackerSteps request={request} />
          {failure && <Failure result={failure} retry={() => setAttempt((n) => n + 1)} />}
        </div>
      )}
    </DepthPanel>
  );
}

function StatusWord({ request }: { request: AddMoneyRequest }) {
  const { t } = addMoneyCopy.useCopy();
  if (request.status === 'credited') return <>{t('status_credited')}</>;
  if (request.status === 'pending') return <>{t('status_pending')}</>;
  if (request.status === 'opened') return <>{t('status_opened')}</>;
  if (request.status === 'opening') return <>{t('status_opening')}</>;
  return <>{request.refusalCode === EXPIRED ? t('status_expired') : t('status_refused', { rail: request.rail })}</>;
}

function Requests() {
  const { t } = addMoneyCopy.useCopy();
  const read = useBankRead('addMoney.requests', { limit: 20 });
  const { resource } = read;
  return (
    <DepthPanel title={t('requestsTitle')} lead={t('requestsLead')}>
      <div data-testid="add-money-requests">
        {resource.status === 'loading' ? (
          <Loading />
        ) : resource.status === 'failed' ? (
          <Failure result={resource.failure} retry={read.reload} />
        ) : resource.data.length === 0 ? (
          <p className="money-caption">{t('noRequests')}</p>
        ) : (
          resource.data.map((row) => (
            <div className="money-space-row" key={row.requestId} data-testid="add-money-request" data-status={row.status}>
              <div>
                <strong>{t(METHOD_KEYS[row.method])}</strong>
                <small>{date(row.createdAt)}</small>
              </div>
              <span className="numeric" dir="ltr">
                {funds(row.amount, row.assetId)}
              </span>
              <span>
                <StatusWord request={row} />
                {row.refusalCode && <small className="muted"> {t('reference', { code: row.refusalCode })}</small>}
              </span>
            </div>
          ))
        )}
      </div>
    </DepthPanel>
  );
}

export function AddMoney() {
  const { t } = addMoneyCopy.useCopy();
  const { api, profiles } = useSession();
  const currencies = useBankRead('currencies.list', { profile: profiles.active });
  const assets = currencies.resource.status === 'ready' ? currencies.resource.data.currencies.map((c) => c.assetId) : [];
  const [assetId, setAssetId] = useState('');
  const [amount, setAmount] = useState('');
  const [country, setCountry] = useState('');
  const [touched, setTouched] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [method, setMethod] = useState<AddMoneyMethod | null>(null);
  const [step, setStep] = useState<'choose' | 'confirm'>('choose');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AddMoneyRequest | Refusal | null>(null);
  const [revision, setRevision] = useState(0);
  // The request the person came back to from the payment page, or the one they just opened.
  const [followed, setFollowed] = useState<string | null>(() => {
    const id = new URLSearchParams(window.location.search).get('request');
    return id && UUID.test(id) ? id : null;
  });
  const [redirecting, setRedirecting] = useState(false);
  // Back from the payment page with the browser's back button, the page may come back as it was left: ready to ask again.
  useEffect(() => {
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) setRedirecting(false);
    };
    window.addEventListener('pageshow', shown);
    return () => window.removeEventListener('pageshow', shown);
  }, []);
  const ways = useBankRead('addMoney.methods', ask, ask !== null);

  const asset = assetId || assets[0] || '';
  const amountBad = touched && !amountOk(amount);
  const countryBad = touched && !/^[A-Za-z]{2}$/.test(country.trim());
  const option = ways.resource.status === 'ready' ? ways.resource.data.methods.find((row) => row.method === method) : undefined;

  function seeWays() {
    setTouched(true);
    if (!asset || !amountOk(amount) || !/^[A-Za-z]{2}$/.test(country.trim())) return;
    const next = { assetId: asset, amount: amount.trim(), country: country.trim().toUpperCase() };
    // The same ask again still needs fresh prices: a quote that ran out must not be offered a second time.
    if (JSON.stringify(next) === JSON.stringify(ask)) ways.reload();
    else setAsk(next);
    setMethod(null);
    setStep('choose');
    setOutcome(null);
  }

  function choose(next: AddMoneyMethod) {
    setMethod(next);
    // A new choice is a new request; asking again for the same choice keeps the same id, so a retry is the same request.
    setRequestId(crypto.randomUUID());
    setOutcome(null);
  }

  async function start() {
    if (!ask || !option) return;
    setBusy(true);
    const result = await api.mutate(
      'bank',
      'addMoney.start',
      { requestId, ...ask, method: option.method, ...(option.quote ? { quoteId: option.quote.quoteId } : {}) },
      addMoneyRequestSchema,
    );
    setBusy(false);
    setOutcome(result.ok ? result.data : result);
    // A hosted way to pay goes on to the page the partner answered with; the person comes back here to the tracker.
    const page = result.ok && result.data.status === 'opened' ? result.data.onramp?.hostedUrl : null;
    if (result.ok && result.data.status === 'opened') setFollowed(result.data.requestId);
    if (page) {
      setRedirecting(true);
      window.location.assign(page);
    }
    // A final answer closes this request, so asking again is a new one. A failure keeps the id, so a retry is the same request.
    if (result.ok && result.data.status !== 'opening') setRequestId(crypto.randomUUID());
    setRevision((n) => n + 1);
  }

  return (
    <div className="bd-stack" data-testid="add-money">
      <DepthPanel title={t('askTitle')}>
        {currencies.resource.status === 'loading' ? (
          <Loading />
        ) : currencies.resource.status === 'failed' ? (
          <Failure result={currencies.resource.failure} retry={currencies.reload} />
        ) : assets.length === 0 ? (
          <p className="money-caption">{t('noCurrency')}</p>
        ) : (
          <div className="bd-stack">
            <label className="field">
              <span>{t('asset')}</span>
              <select value={asset} onChange={(event) => setAssetId(event.target.value)}>
                {assets.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <small>{t('assetHint')}</small>
            </label>
            <Field
              label={t('amount')}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              error={amountBad ? t('amountBad') : undefined}
            />
            <Field
              label={t('country')}
              hint={t('countryHint')}
              value={country}
              maxLength={2}
              autoComplete="country"
              onChange={(event) => setCountry(event.target.value)}
              error={countryBad ? t('countryBad') : undefined}
            />
            <div className="actions">
              <Button onClick={seeWays}>{t('seeWays')}</Button>
            </div>
          </div>
        )}
      </DepthPanel>

      {ask && (
        <DepthPanel title={t('waysTitle')}>
          {ways.resource.status === 'loading' ? (
            <Loading />
          ) : ways.resource.status === 'failed' ? (
            <Failure result={ways.resource.failure} retry={ways.reload} />
          ) : (
            <fieldset className="bd-methods" data-testid="add-money-ways" aria-label={t('waysTitle')}>
              <div className="bd-choice-row" role="radiogroup" aria-label={t('waysTitle')}>
                {ways.resource.data.methods.map((row) => (
                  <Method key={row.method} row={row} chosen={row.method === method} onChoose={() => choose(row.method)} />
                ))}
              </div>
              <div className="actions">
                <Button onClick={() => setStep('confirm')} disabled={!option}>
                  {t('continue')}
                </Button>
              </div>
            </fieldset>
          )}
        </DepthPanel>
      )}

      {ask && option && step === 'confirm' && (
        <DepthPanel title={t(METHOD_KEYS[option.method])}>
          <div className="bd-stack" data-testid="add-money-confirm">
            {option.method === 'bank_transfer' && (
              <div>
                <h3>{t('ownershipTitle')}</h3>
                <p>{t('ownership')}</p>
              </div>
            )}
            {option.method === 'pay_by_bank' && <p>{t('redirect')}</p>}
            {(option.method === 'card' || option.method === 'wallet_pay') && <p>{t('hostedCard')}</p>}
            <div className="actions">
              <Button onClick={() => void start()} disabled={busy || redirecting}>
                {redirecting ? t('redirecting') : busy ? t('working') : t('ask')}
              </Button>
            </div>
            {outcome && <Answer outcome={outcome} />}
          </div>
        </DepthPanel>
      )}

      {followed && <Tracker key={followed} requestId={followed} onSettled={() => setRevision((n) => n + 1)} />}

      {/* A new request reads both lists again. */}
      <IncomingPayments key={`in-${revision}`} />
      <Requests key={revision} />
    </div>
  );
}
