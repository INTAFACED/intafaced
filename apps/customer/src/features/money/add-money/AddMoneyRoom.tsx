// volt-room: /bank/ramps/new
import { useEffect, useState } from 'react';
import { Button, Field, Radio } from '@intafaced/ui/lit';
import { FlowTemplate, SelectField, type RoomState } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { decimalSchema, parseAmount } from '../../../shared/money';
import { useWallet, WalletProvider } from '../../protocol';
import { useSession } from '../../session';
import { addMoneyCopy } from '../add-money-copy';
import { BankTabs } from '../bank-frame/BankFrame';
import { Failure, Loading, Panel } from '../bank-settings/parts';
import { date, funds, useBankRecord } from '../components';
import { type AddMoneyMethod, type AddMoneyOption, type AddMoneyRequest } from '../contracts';
import { startAddMoney } from '../AddMoney';
import { IncomingPayments } from './IncomingPayments';
import { BANK_ADD_MONEY_REQUEST, BANK_ADD_MONEY_REQUESTS, BANK_ADD_MONEY_METHODS } from '@intafaced/contracts/bank-add-money-procedures';
import { leaveTo } from '../../../app/location';
import { shownCode, withCode } from '../../../shared/reference';
import { BANK_CURRENCIES_LIST } from '@intafaced/contracts/bank-currencies-procedures';

/**
 * Add money (J-bank-02, J-wallet-01 #3): the amount, every way to pay with the fee and arrival the bank quoted (a blank reads "not set"),
 * and the request itself. A way to pay with no partner says which rail it needs and why; asking anyway keeps the request,
 * refused, in the list below, and nothing is charged or added. A way to pay a partner opens as a hosted page sends the
 * person to the page the partner answered with; coming back (`?request=<id>`), the tracker follows that request from
 * created to credited, reading the bank until it is credited. Every figure is the service's own string.
 *
 * Buy to wallet (J-dex-protocol-05 #4): "Deliver to" chooses the exchange balance or the person's own connected wallet.
 * For the wallet the request names its address, the partner delivers the purchase there on chain, and nothing is
 * credited here; the tracker's last step is the partner's delivery, with the address and its on-chain transfer.
 */

type Ask = { assetId: string; amount: string; country: string };
/** The methods read's input while nothing is asked: the read is off then, so this is never sent. */
const NO_ASK: Ask = { assetId: '', amount: '', country: '' };
type Deliver = 'balance' | 'wallet';
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

const READY: RoomState = { kind: 'ready' };
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

/**
 * The exact text the person signs with their wallet to have a purchase delivered to it: svc-bank's
 * `walletDeliveryMessage`, which checks the signature against this same text.
 */
export function walletDeliveryMessage(requestId: string, walletAddress: string): string {
  return [
    'INTAFACED buy to wallet',
    `Request: ${requestId.toLowerCase()}`,
    `Wallet: ${walletAddress.toLowerCase()}`,
    'Signing this proves you control this wallet, so a purchase can be delivered to it. It moves no funds and approves nothing else.',
  ].join('\n');
}

function amountOk(value: string) {
  return decimalSchema.safeParse(value.trim()).success && parseAmount(value.trim()) > 0n;
}

function Method({ row, chosen, onChoose }: { row: AddMoneyOption; chosen: boolean; onChoose: () => void }) {
  const { t } = addMoneyCopy.useCopy();
  const quote = row.quote;
  // The partner's ramp gave no fee: the fee and the pay amount are "not known", never 0, and the way to pay is not offered.
  const feeUnknown = row.blocker === FEE_NOT_KNOWN;
  return (
    <div className="lt-panel lt-stack-tight" data-testid={`method-${row.method}`} data-selected={chosen ? 'true' : undefined}>
      <Radio name="add-money-method" value={row.method} checked={chosen} onSelect={onChoose}>
        <strong>{t(METHOD_KEYS[row.method])}</strong>
      </Radio>
      <span className="lt-muted">
        {t('fee')}: {quote ? funds(quote.fee, quote.payCurrency) : feeUnknown ? t('notKnown') : t('notSet')}
      </span>
      <span className="lt-muted">
        {t('arrives')}: {quote?.deliveryEstimate ?? t('notSet')}
      </span>
      <span className="lt-muted">
        {t('youPay')}: {quote ? funds(quote.payAmount, quote.payCurrency) : feeUnknown ? t('notKnown') : t('notSet')}
      </span>
      {quote && (
        <span className="lt-muted" data-testid="method-receive">
          {t('youReceive')}: {funds(quote.amount, quote.assetId)}
        </span>
      )}
      {quote && (
        <span className="lt-muted">
          {t('priceUntil')}: {date(quote.expiresAt, true)}
        </span>
      )}
      {row.standIn && (
        <small className="lt-muted">
          {row.payStandIn ? t('standInPriced', { label: row.standIn }) : t('standIn', { label: row.standIn })}
        </small>
      )}
      {row.quote && row.payStandIn && (
        <small className="lt-muted">
          {t(row.method === 'bank_transfer' ? 'payStandInTransfer' : 'payStandIn', { label: row.payStandIn })}
        </small>
      )}
      {row.blocker && (
        <small className="lt-muted" data-code={row.blocker}>
          {withCode(feeUnknown ? t('feeNotKnown') : t('railOff', { rail: row.rail }), row.blocker, (code) => t('reference', { code }))}
        </small>
      )}
    </div>
  );
}

function Refused({ title, body, reference, code }: { title: string; body: string; reference: string; code?: string | null }) {
  return (
    <div className="lt-refusal" role="status" data-testid="add-money-refused" data-code={code ?? undefined}>
      <h3>{title}</h3>
      <p>{body}</p>
      <small className="lt-muted">{reference}</small>
    </div>
  );
}

/** What asking answered: a kept request, a price that ran out before anything was kept, or another failure. */
function Answer({ outcome }: { outcome: AddMoneyRequest | Refusal }) {
  const { t } = addMoneyCopy.useCopy();
  if (!('ok' in outcome)) return <Outcome request={outcome} />;
  if (outcome.code !== EXPIRED) return <Failure result={outcome} />;
  return (
    <Refused
      title={t('expiredTitle')}
      body={t('expiredNow')}
      reference={withCode('', EXPIRED, (code) => t('reference', { code })).trim()}
      code={EXPIRED}
    />
  );
}

function Outcome({ request }: { request: AddMoneyRequest }) {
  const { t } = addMoneyCopy.useCopy();
  if (request.status === 'refused') {
    const expired = request.refusalCode === EXPIRED;
    return (
      <Refused
        title={expired ? t('expiredTitle') : t('refusedTitle')}
        body={expired ? t('expiredBody') : t('refusedBody', { rail: request.rail })}
        code={request.refusalCode}
        reference={shownCode(request.refusalCode) ? `${request.rail} · ${t('reference', { code: request.refusalCode! })}` : request.rail}
      />
    );
  }
  const onramp = request.onramp;
  return (
    <div className="lt-stack" role="status" data-testid="add-money-opened">
      <h3>{t('openedTitle')}</h3>
      {onramp?.bankInstructions && <p data-testid="add-money-ownership">{t('ownership')}</p>}
      {onramp?.bankInstructions && (
        <dl className="lt-kv">
          <div>
            <dt>{t('payReference')}</dt>
            <dd>
              <span lang="und">{onramp.bankInstructions.reference}</span>
            </dd>
          </div>
          <div>
            <dt>{t('accountName')}</dt>
            <dd>
              <span lang="und">{onramp.bankInstructions.accountName}</span>
            </dd>
          </div>
          <div>
            <dt>{t('account')}</dt>
            <dd>
              <span lang="und">{onramp.bankInstructions.accountRef}</span>
            </dd>
          </div>
          <div>
            <dt>{t('youPay')}</dt>
            <dd>{funds(onramp.payAmount, onramp.payCurrency)}</dd>
          </div>
        </dl>
      )}
      {onramp?.hostedUrl && (
        <a className="lt-button lt-button-primary" href={onramp.hostedUrl} rel="noopener noreferrer">
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

/** When the request reached each step, or null while it has not. A wallet purchase's last step is its delivery. */
function reachedAt(request: AddMoneyRequest, step: (typeof STEPS)[number]): string | null {
  if (step === 'created') return request.createdAt;
  if (step === 'opened') return request.openedAt;
  if (step === 'pending') return request.pendingAt;
  return request.walletAddress ? request.deliveredAt : request.creditedAt;
}

/** The person's wallet a purchase goes to, and once delivered, the partner's transfer on chain. */
function Delivery({ request }: { request: AddMoneyRequest }) {
  const { t } = addMoneyCopy.useCopy();
  if (!request.walletAddress) return null;
  return (
    <p className="lt-muted" data-testid="tracker-delivery" data-state={request.deliveryTx ? 'delivered' : 'waiting'}>
      <span lang="und" dir="ltr">
        {request.deliveryTx
          ? t('deliveredTo', { address: request.walletAddress })
          : `${t('deliverWalletAddress')}: ${request.walletAddress}`}
      </span>
      {request.deliveryTx && (
        <>
          {' · '}
          <a className="lt-link" href={`/chain/tx/${request.deliveryTx}`} data-testid="tracker-delivery-tx">
            {t('deliveryTx')}
          </a>
        </>
      )}
    </p>
  );
}

/** Where one request stands, step by step, with when each happened and what was credited. */
export function TrackerSteps({ request }: { request: AddMoneyRequest }) {
  const { t } = addMoneyCopy.useCopy();
  return (
    <>
      <p className="lt-muted">
        <strong>{t(METHOD_KEYS[request.method])}</strong> · <StatusWord request={request} />
      </p>
      <ol className="lt-stack">
        {STEPS.map((step) => {
          const at = reachedAt(request, step);
          const state = stepState(request, step);
          return (
            <li key={step} data-testid="tracker-step" data-step={step} data-state={state}>
              <strong>{t(step === 'credited' && request.walletAddress ? 'step_delivered' : STEP_KEYS[step])}</strong>{' '}
              <small className="lt-muted">{at ? date(at, true) : state === 'skipped' ? t('stepSkipped') : t('stepNotYet')}</small>
            </li>
          );
        })}
      </ol>
      <p className="lt-muted" data-testid="tracker-receive">
        {t('trackerAmount')}: <span dir="ltr">{funds(request.onramp?.amount ?? request.amount, request.assetId)}</span>
      </p>
      <Delivery request={request} />
      {request.creditedAmount && (
        <p data-testid="tracker-credited">
          <span dir="ltr">{t('creditedAmount', { amount: funds(request.creditedAmount, request.assetId) })}</span>
        </p>
      )}
      {request.returnedAt && request.creditedAmount && (
        <p data-testid="tracker-returned">
          {t('returnedAmount', { amount: funds(request.creditedAmount, request.assetId), time: date(request.returnedAt, true) })}
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
      const result = await api.call(BANK_ADD_MONEY_REQUEST, { requestId });
      if (stopped) return;
      reads += 1;
      if (result.ok) {
        failures = 0;
        setRequest(result.data);
        setFailure(null);
        const final = ['credited', 'returned', 'refused', 'delivered'];
        if (final.includes(result.data.status)) {
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
    <Panel title={t('trackerTitle')} lead={t('trackerLead')}>
      {failure && !request ? (
        <Failure result={failure} retry={() => setAttempt((n) => n + 1)} />
      ) : !request ? (
        <Loading />
      ) : (
        <div className="lt-stack" data-testid="add-money-tracker" data-status={request.status}>
          <TrackerSteps request={request} />
          {failure && <Failure result={failure} retry={() => setAttempt((n) => n + 1)} />}
        </div>
      )}
    </Panel>
  );
}

function StatusWord({ request }: { request: AddMoneyRequest }) {
  const { t } = addMoneyCopy.useCopy();
  if (request.status === 'delivered') return <>{t('status_delivered')}</>;
  if (request.status === 'returned') return <>{t('status_returned')}</>;
  if (request.status === 'credited') return <>{t('status_credited')}</>;
  if (request.status === 'pending') return <>{t('status_pending')}</>;
  if (request.status === 'opened') return <>{t('status_opened')}</>;
  if (request.status === 'opening') return <>{t('status_opening')}</>;
  return <>{request.refusalCode === EXPIRED ? t('status_expired') : t('status_refused', { rail: request.rail })}</>;
}

function Requests() {
  const { t } = addMoneyCopy.useCopy();
  const read = useBankRecord(BANK_ADD_MONEY_REQUESTS, { limit: 20 });
  const { resource } = read;
  return (
    <Panel title={t('requestsTitle')} lead={t('requestsLead')}>
      <div className="lt-rows" data-testid="add-money-requests">
        {resource.status === 'loading' ? (
          <Loading />
        ) : resource.status === 'failed' ? (
          <Failure result={resource.failure} retry={read.reload} />
        ) : resource.data.length === 0 ? (
          <p className="lt-muted">{t('noRequests')}</p>
        ) : (
          resource.data.map((row) => (
            <div className="lt-row lt-row-between" key={row.requestId} data-testid="add-money-request" data-status={row.status}>
              <div className="lt-stack-tight">
                <strong>{t(METHOD_KEYS[row.method])}</strong>
                <small className="lt-muted">{date(row.createdAt)}</small>
              </div>
              <span className="lt-num" dir="ltr">
                {funds(row.amount, row.assetId)}
              </span>
              <span>
                <StatusWord request={row} />
                {row.refusalCode && (
                  <small className="lt-muted" data-code={row.refusalCode}>
                    {shownCode(row.refusalCode) ? ` ${t('reference', { code: row.refusalCode })}` : null}
                  </small>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

function AddMoney() {
  const { t } = addMoneyCopy.useCopy();
  const { api, profiles } = useSession();
  const wallet = useWallet();
  const [deliver, setDeliver] = useState<Deliver>('balance');
  const [unsigned, setUnsigned] = useState(false);
  // The connected wallet's address, only while connected: buying to it names it on the request.
  const walletAddress = wallet.status === 'connected' ? wallet.address : null;
  const currencies = useBankRecord(BANK_CURRENCIES_LIST, { profile: profiles.active });
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
  const ways = useBankRecord(BANK_ADD_MONEY_METHODS, ask ?? NO_ASK, ask !== null);

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

  function deliverTo(next: Deliver) {
    setDeliver(next);
    // Another destination is other terms: a new request.
    setRequestId(crypto.randomUUID());
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
    if (deliver === 'wallet' && !walletAddress) return;
    setBusy(true);
    setUnsigned(false);
    // The wallet proves it is the person's: it signs this request's own message, and the bank checks the signer.
    let walletSignature: string | null = null;
    if (deliver === 'wallet' && walletAddress) {
      const signed = await wallet.sign({ kind: 'message', message: walletDeliveryMessage(requestId, walletAddress) });
      if (signed.status !== 'signed') {
        setBusy(false);
        setUnsigned(true);
        return;
      }
      walletSignature = signed.signature;
    }
    const result = await startAddMoney(api, {
      requestId,
      ...ask,
      method: option.method,
      ...(option.quote ? { quoteId: option.quote.quoteId } : {}),
      ...(deliver === 'wallet' && walletAddress && walletSignature ? { walletAddress, walletSignature } : {}),
    });
    setBusy(false);
    setOutcome(result.ok ? result.data : result);
    // A hosted way to pay goes on to the page the partner answered with; the person comes back here to the tracker.
    const page = result.ok && result.data.status === 'opened' ? result.data.onramp?.hostedUrl : null;
    if (result.ok && result.data.status === 'opened') setFollowed(result.data.requestId);
    if (page) {
      setRedirecting(true);
      leaveTo(page);
    }
    // A final answer closes this request, so asking again is a new one. A failure keeps the id, so a retry is the same request.
    if (result.ok && result.data.status !== 'opening') setRequestId(crypto.randomUUID());
    setRevision((n) => n + 1);
  }

  return (
    <div className="lt-stack" data-testid="add-money">
      <Panel title={t('askTitle')}>
        {currencies.resource.status === 'loading' ? (
          <Loading />
        ) : currencies.resource.status === 'failed' ? (
          <Failure result={currencies.resource.failure} retry={currencies.reload} />
        ) : assets.length === 0 ? (
          <p className="lt-muted">{t('noCurrency')}</p>
        ) : (
          <div className="lt-stack">
            <SelectField label={t('asset')} value={asset} onChange={setAssetId} options={assets} hint={t('assetHint')} />
            <fieldset className="lt-stack" aria-label={t('deliverTo')}>
              <span>{t('deliverTo')}</span>
              <div className="lt-cols-2" role="radiogroup" aria-label={t('deliverTo')}>
                <Radio name="add-money-deliver" value="balance" checked={deliver === 'balance'} onSelect={() => deliverTo('balance')}>
                  <strong>{t('deliverBalance')}</strong>
                </Radio>
                <Radio
                  name="add-money-deliver"
                  value="wallet"
                  checked={deliver === 'wallet'}
                  disabled={!walletAddress}
                  onSelect={() => deliverTo('wallet')}
                >
                  <strong>{t('deliverWallet')}</strong>
                </Radio>
              </div>
              <p className="lt-muted" data-testid="ramp-destination" data-deliver={deliver}>
                {deliver === 'wallet' && walletAddress ? (
                  <>
                    {t('deliverWalletAddress')}:{' '}
                    <span lang="und" dir="ltr">
                      {walletAddress}
                    </span>
                    . {t('deliverWalletNote')}
                  </>
                ) : (
                  <>
                    {t('deliverBalance')}. {t('deliverBalanceNote')}
                    {!walletAddress && <> {t('deliverNoWallet')}</>}
                  </>
                )}
              </p>
            </fieldset>
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
            <div className="lt-actions">
              <Button tone="primary" onClick={seeWays}>
                {t('seeWays')}
              </Button>
            </div>
          </div>
        )}
      </Panel>

      {ask && (
        <Panel title={t('waysTitle')}>
          {ways.resource.status === 'loading' ? (
            <Loading />
          ) : ways.resource.status === 'failed' ? (
            <Failure result={ways.resource.failure} retry={ways.reload} />
          ) : (
            <fieldset className="lt-stack" data-testid="add-money-ways" aria-label={t('waysTitle')}>
              <div className="lt-cols-2" role="radiogroup" aria-label={t('waysTitle')}>
                {ways.resource.data.methods.map((row) => (
                  <Method key={row.method} row={row} chosen={row.method === method} onChoose={() => choose(row.method)} />
                ))}
              </div>
              <div className="lt-actions">
                <Button tone="primary" onClick={() => setStep('confirm')} disabled={!option}>
                  {t('continue')}
                </Button>
              </div>
            </fieldset>
          )}
        </Panel>
      )}

      {ask && option && step === 'confirm' && (
        <Panel title={t(METHOD_KEYS[option.method])}>
          <div className="lt-stack" data-testid="add-money-confirm">
            {option.method === 'bank_transfer' && (
              <div>
                <h3>{t('ownershipTitle')}</h3>
                <p>{t('ownership')}</p>
              </div>
            )}
            {deliver === 'wallet' && walletAddress && <p data-testid="add-money-sign-note">{t('deliverSign')}</p>}
            {option.method === 'pay_by_bank' && <p>{t('redirect')}</p>}
            {(option.method === 'card' || option.method === 'wallet_pay') && <p>{t('hostedCard')}</p>}
            <div className="lt-actions">
              <Button
                tone="primary"
                onClick={() => void start()}
                disabled={busy || redirecting || (deliver === 'wallet' && !walletAddress)}
              >
                {redirecting ? t('redirecting') : busy ? t('working') : t('ask')}
              </Button>
            </div>
            {unsigned && (
              <p className="lt-muted" role="status" data-testid="add-money-unsigned">
                {t('deliverUnsigned')}
              </p>
            )}
            {outcome && <Answer outcome={outcome} />}
          </div>
        </Panel>
      )}

      {followed && <Tracker key={followed} requestId={followed} onSettled={() => setRevision((n) => n + 1)} />}

      {/* A new request reads both lists again. */}
      <IncomingPayments key={`in-${revision}`} />
      <Requests key={revision} />
    </div>
  );
}

/** `/bank/ramps/new`: add money, on the flow template. */
export function AddMoneyRoom() {
  const { t } = addMoneyCopy.useCopy();
  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={READY}
      step={
        <div className="lt-stack">
          <BankTabs />
          {/* The browser wallet's connection, so a purchase can be delivered straight to it (J-dex-protocol-05 #4). */}
          <WalletProvider>
            <AddMoney />
          </WalletProvider>
        </div>
      }
    />
  );
}
