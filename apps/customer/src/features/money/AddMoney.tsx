import { useState } from 'react';
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
 * refused, in the list below, and nothing is charged or added. Every figure is the service's own string.
 */

type Ask = { assetId: string; amount: string; country: string };
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

const EXPIRED = 'bank.onramp_quote_expired';

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
  return (
    <label className={`bd-choice ${chosen ? 'bd-choice--on' : ''}`} data-testid={`method-${row.method}`}>
      <input type="radio" name="add-money-method" value={row.method} checked={chosen} onChange={onChoose} />
      <strong>{t(METHOD_KEYS[row.method])}</strong>
      <span className="money-caption">
        {t('fee')}: {quote ? funds(quote.fee, quote.payCurrency) : t('notSet')}
      </span>
      <span className="money-caption">
        {t('arrives')}: {quote?.deliveryEstimate ?? t('notSet')}
      </span>
      <span className="money-caption">
        {t('youPay')}: {quote ? funds(quote.payAmount, quote.payCurrency) : t('notSet')}
      </span>
      {row.blocker && (
        <small className="muted">
          {t('railOff', { rail: row.rail })} {t('reference', { code: row.blocker })}
        </small>
      )}
    </label>
  );
}

function Outcome({ request }: { request: AddMoneyRequest }) {
  const { t } = addMoneyCopy.useCopy();
  if (request.status === 'refused') {
    const expired = request.refusalCode === EXPIRED;
    return (
      <div className="failure" role="status" data-testid="add-money-refused">
        <h3>{expired ? t('expiredTitle') : t('refusedTitle')}</h3>
        <p>{expired ? t('expiredBody') : t('refusedBody', { rail: request.rail })}</p>
        <small className="muted">
          {request.rail} · {t('reference', { code: request.refusalCode ?? '' })}
        </small>
      </div>
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

function StatusWord({ request }: { request: AddMoneyRequest }) {
  const { t } = addMoneyCopy.useCopy();
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
  const ways = useBankRead('addMoney.methods', ask, ask !== null);

  const asset = assetId || assets[0] || '';
  const amountBad = touched && !amountOk(amount);
  const countryBad = touched && !/^[A-Za-z]{2}$/.test(country.trim());
  const option = ways.resource.status === 'ready' ? ways.resource.data.methods.find((row) => row.method === method) : undefined;

  function seeWays() {
    setTouched(true);
    if (!asset || !amountOk(amount) || !/^[A-Za-z]{2}$/.test(country.trim())) return;
    setAsk({ assetId: asset, amount: amount.trim(), country: country.trim().toUpperCase() });
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
              <Button onClick={() => void start()} disabled={busy}>
                {busy ? t('working') : t('ask')}
              </Button>
            </div>
            {outcome && ('ok' in outcome ? <Failure result={outcome} /> : <Outcome request={outcome} />)}
          </div>
        </DepthPanel>
      )}

      {/* A new request reads both lists again. */}
      <IncomingPayments key={`in-${revision}`} />
      <Requests key={revision} />
    </div>
  );
}
