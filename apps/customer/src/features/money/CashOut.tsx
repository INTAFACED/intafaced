import { useId, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { decimalSchema, parseAmount } from '../../shared/money';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { cashOutCopy } from './cash-out-copy';
import { date, funds, useBankRead } from './components';
import { cashOutRequestSchema, type CashOutQuote, type CashOutRequest } from './contracts';
import { DepthPanel, Fact } from './DepthParts';
import { WithdrawStepUp } from './WithdrawStepUp';
import './bank-depth.css';

/**
 * Cash out to a linked bank account (J-bank-03): the amount, one of the person's linked accounts, and what the bank
 * says stands in the way. No partner prices a cash-out in this build, so the fee and the amount that arrives read
 * "not set", never a guess. Asking anyway needs a fresh confirmation (`trade:withdraw`) and is kept, refused, in the
 * list below with its reason; nothing leaves the balance. Every figure is the service's own string.
 */

type Ask = { assetId: string; amount: string; linkedAccountId: string };
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Key = Parameters<ReturnType<typeof cashOutCopy.useCopy>['t']>[0];

const BLOCKER_KEYS: Record<string, Key> = {
  'bank.linked_account_unverified': 'why_bank_linked_account_unverified',
  'bank.offramp_cooling_unset': 'why_bank_offramp_cooling_unset',
  'bank.offramp_cooling_active': 'why_bank_offramp_cooling_active',
  'bank.fiat_ramp_socket': 'why_bank_fiat_ramp_socket',
};

function amountOk(value: string) {
  return decimalSchema.safeParse(value.trim()).success && parseAmount(value.trim()) > 0n;
}

/** The bank's reason in the person's words, with the code to quote. */
export function BlockerWords({ code, rail, coolingOffEndsAt }: { code: string; rail: string; coolingOffEndsAt?: string | null }) {
  const { t } = cashOutCopy.useCopy();
  const key = BLOCKER_KEYS[code] ?? 'why_other';
  return (
    <>
      {t(key, { rail, code, time: coolingOffEndsAt ? date(coolingOffEndsAt) : '' })}{' '}
      <small className="muted">{t('reference', { code })}</small>
    </>
  );
}

export function QuoteView({ quote }: { quote: CashOutQuote }) {
  const { t } = cashOutCopy.useCopy();
  return (
    <div className="bd-stack" data-testid="cash-out-quote">
      <dl className="bd-facts">
        <Fact label={t('amount')}>{funds(quote.amount, quote.assetId)}</Fact>
        <Fact label={t('available')}>{funds(quote.available, quote.assetId)}</Fact>
        <Fact label={t('account')}>
          <span lang="und">
            {quote.account.label} ({quote.account.ibanMasked})
          </span>
        </Fact>
        <Fact label={t('fee')}>{quote.fee === null ? t('notSet') : funds(quote.fee, quote.assetId)}</Fact>
        <Fact label={t('receive')}>{quote.receiveAmount === null ? t('notSet') : funds(quote.receiveAmount, quote.assetId)}</Fact>
      </dl>
      <p role="status" data-testid="cash-out-blocker">
        <BlockerWords code={quote.blocker} rail={quote.rail} coolingOffEndsAt={quote.account.coolingOffEndsAt} />
      </p>
    </div>
  );
}

function QuoteFailure({ failure, retry }: { failure: Refusal; retry: () => void }) {
  const { t } = cashOutCopy.useCopy();
  if (failure.code === 'bank.cash_out_over_available') {
    return (
      <p className="failure" role="alert">
        {t('overAvailable')} <small className="muted">{t('reference', { code: failure.code })}</small>
      </p>
    );
  }
  return <Failure result={failure} retry={retry} />;
}

export function RequestRows({ rows }: { rows: readonly CashOutRequest[] }) {
  const { t } = cashOutCopy.useCopy();
  if (rows.length === 0) return <p className="money-caption">{t('noRequests')}</p>;
  return (
    <>
      {rows.map((row) => (
        <div className="money-space-row" key={row.requestId} data-testid="cash-out-request" data-status={row.status}>
          <div>
            <strong>{t('status_refused')}</strong>
            <small>{date(row.createdAt)}</small>
          </div>
          <span className="numeric" dir="ltr">
            {funds(row.amount, row.assetId)}
          </span>
          <span>
            <small className="muted">
              {row.rail} · {t('reference', { code: row.refusalCode })}
            </small>
          </span>
        </div>
      ))}
    </>
  );
}

function Requests() {
  const { t } = cashOutCopy.useCopy();
  const read = useBankRead('cashOut.requests', { limit: 20 });
  const { resource } = read;
  return (
    <DepthPanel title={t('requestsTitle')} lead={t('requestsLead')}>
      <div data-testid="cash-out-requests">
        {resource.status === 'loading' ? (
          <Loading />
        ) : resource.status === 'failed' ? (
          <Failure result={resource.failure} retry={read.reload} />
        ) : (
          <RequestRows rows={resource.data} />
        )}
      </div>
    </DepthPanel>
  );
}

/** `/bank/ramps/cash-out`: cash out to one of the person's linked bank accounts. */
export function CashOut() {
  const { t } = cashOutCopy.useCopy();
  const { api, profiles } = useSession();
  const currencies = useBankRead('currencies.list', { profile: profiles.active });
  const linked = useBankRead('linkedAccounts.list', undefined);
  const assets = currencies.resource.status === 'ready' ? currencies.resource.data.currencies.map((c) => c.assetId) : [];
  const accounts = linked.resource.status === 'ready' ? linked.resource.data.accounts : [];
  const [assetId, setAssetId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [touched, setTouched] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [outcome, setOutcome] = useState<CashOutRequest | null>(null);
  const [revision, setRevision] = useState(0);
  const quote = useBankRead('cashOut.quote', ask, ask !== null);
  const assetField = useId();
  const accountField = useId();

  const asset = assetId || assets[0] || '';
  const account = accountId || accounts[0]?.accountId || '';
  const amountBad = touched && !amountOk(amount);

  function see() {
    setTouched(true);
    if (!asset || !account || !amountOk(amount)) return;
    setAsk({ assetId: asset, amount: amount.trim(), linkedAccountId: account });
    setOutcome(null);
    // A new quote is a new request; a retry of the same confirmation keeps the id, so it is the same request.
    setRequestId(crypto.randomUUID());
  }

  const loading = currencies.resource.status === 'loading' || linked.resource.status === 'loading';
  return (
    <div className="bd-stack" data-testid="cash-out">
      <DepthPanel title={t('askTitle')}>
        {loading ? (
          <Loading />
        ) : currencies.resource.status === 'failed' ? (
          <Failure result={currencies.resource.failure} retry={currencies.reload} />
        ) : linked.resource.status === 'failed' ? (
          <Failure result={linked.resource.failure} retry={linked.reload} />
        ) : assets.length === 0 ? (
          <p className="money-caption">{t('noCurrency')}</p>
        ) : accounts.length === 0 ? (
          <div className="bd-stack">
            <p className="money-caption">{t('noAccounts')}</p>
            <div className="actions">
              <a className="button" href="/bank/ramps/accounts">
                {t('linkOne')}
              </a>
            </div>
          </div>
        ) : (
          <div className="bd-stack">
            <label className="field" htmlFor={assetField}>
              <span>{t('asset')}</span>
              <select id={assetField} value={asset} onChange={(event) => setAssetId(event.target.value)}>
                {assets.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label={t('amount')}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              error={amountBad ? t('amountBad') : undefined}
            />
            <label className="field" htmlFor={accountField}>
              <span>{t('account')}</span>
              <select id={accountField} value={account} onChange={(event) => setAccountId(event.target.value)}>
                {accounts.map((row) => (
                  <option key={row.accountId} value={row.accountId}>
                    {row.label} ({row.ibanMasked})
                  </option>
                ))}
              </select>
            </label>
            <div className="actions">
              <Button onClick={see}>{t('see')}</Button>
            </div>
          </div>
        )}
      </DepthPanel>

      {ask && (
        <DepthPanel title={t('quoteTitle')}>
          {quote.resource.status === 'loading' ? (
            <Loading />
          ) : quote.resource.status === 'failed' ? (
            <QuoteFailure failure={quote.resource.failure} retry={quote.reload} />
          ) : (
            <div className="bd-stack">
              <QuoteView quote={quote.resource.data} />
              <div className="actions">
                <Button variant="primary" onClick={() => setConfirming(true)}>
                  {t('confirm')}
                </Button>
              </div>
              {outcome && (
                <div className="failure" role="status" data-testid="cash-out-kept">
                  <h3>{t('keptTitle')}</h3>
                  <p>{t('keptBody')}</p>
                  <p>
                    <BlockerWords
                      code={outcome.refusalCode}
                      rail={outcome.rail}
                      coolingOffEndsAt={quote.resource.data.account.coolingOffEndsAt}
                    />
                  </p>
                </div>
              )}
            </div>
          )}
        </DepthPanel>
      )}

      {confirming && ask && (
        <WithdrawStepUp
          why={t('confirmWhy')}
          run={async (token) => {
            const answer = await api.mutate('bank', 'cashOut.start', { requestId, ...ask }, cashOutRequestSchema, { bearer: token });
            if (answer.ok) setOutcome(answer.data);
            return answer;
          }}
          onDone={() => {
            setConfirming(false);
            // A final answer closes this request, so asking again is a new one.
            setRequestId(crypto.randomUUID());
            setRevision((n) => n + 1);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}

      {/* A new request reads the list again. */}
      <Requests key={revision} />
      <p>
        <a className="text-link" href="/bank/ramps">
          {t('back')}
        </a>
      </p>
    </div>
  );
}
