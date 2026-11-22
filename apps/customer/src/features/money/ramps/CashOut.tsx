import { useId, useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { KeyValue, Skeleton } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { decimalSchema, parseAmount } from '../../../shared/money';
import { useSession } from '../../session';
import { cashOutCopy } from '../cash-out-copy';
import { date, funds, useBankRead, useBankRecord } from '../components';
import { type CashOutQuote, type CashOutReceipt, type CashOutRequest } from '../contracts';
import { FailureNote, Panel, StepUpSheet } from './parts';
import {
  BANK_CASH_OUT_REQUESTS,
  BANK_CASH_OUT_RECEIPT,
  BANK_CASH_OUT_QUOTE,
  BANK_CASH_OUT_START,
} from '@intafaced/contracts/bank-cash-out-procedures';
import { BANK_LINKED_ACCOUNTS_LIST } from '@intafaced/contracts/bank-linked-accounts-procedures';

/**
 * Cash out to a linked bank account (J-bank-03): the amount, one of the person's linked accounts, and what the bank
 * says stands in the way. While something does, the fee and the amount that arrives read "not set", never a guess.
 * Asking needs a fresh confirmation (`trade:withdraw`). A cash-out something stands in the way of is kept, refused, in
 * the list below with its reason, and nothing leaves the balance. One the bank's partner takes is held and tracked from
 * processing to completed, with a signed receipt once paid; a failed or returned one says why and what came back.
 * Every figure is the service's own string.
 */

type Ask = { assetId: string; amount: string; linkedAccountId: string };
/** The quote read's input while nothing is asked: the read is off then, so this is never sent. */
const NO_ASK: Ask = { assetId: '', amount: '', linkedAccountId: '' };
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Key = Parameters<ReturnType<typeof cashOutCopy.useCopy>['t']>[0];

type BlockerKey = Extract<Key, `why_${string}`>;
const BLOCKER_KEYS: Record<string, BlockerKey> = {
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
      {t(key, { rail, time: coolingOffEndsAt ? date(coolingOffEndsAt) : '' })} <small className="lt-hint">{t('reference', { code })}</small>
    </>
  );
}

export function QuoteView({ quote }: { quote: CashOutQuote }) {
  const { t } = cashOutCopy.useCopy();
  return (
    <div data-testid="cash-out-quote">
      <KeyValue
        rows={[
          { label: t('amount'), value: funds(quote.amount, quote.assetId) },
          {
            label: quote.heldAt ? t('availableAt', { label: quote.heldAt }) : t('available'),
            value: funds(quote.available, quote.assetId),
          },
          {
            label: t('account'),
            value: (
              <span lang="und">
                {quote.account.label} ({quote.account.ibanMasked})
              </span>
            ),
          },
          { label: t('fee'), value: quote.fee === null ? t('notSet') : funds(quote.fee, quote.receiveCurrency ?? quote.assetId) },
          {
            label: t('receive'),
            value: quote.receiveAmount === null ? t('notSet') : funds(quote.receiveAmount, quote.receiveCurrency ?? quote.assetId),
          },
        ]}
      />
      {quote.blocker === null ? (
        quote.standIn && (
          <p className="lt-hint" data-testid="cash-out-stand-in">
            {t('standIn', { label: quote.standIn })}
          </p>
        )
      ) : (
        <p role="status" data-testid="cash-out-blocker">
          <BlockerWords code={quote.blocker} rail={quote.rail} coolingOffEndsAt={quote.account.coolingOffEndsAt} />
        </p>
      )}
    </div>
  );
}

function QuoteFailure({ failure, retry }: { failure: Refusal; retry: () => void }) {
  const { t } = cashOutCopy.useCopy();
  if (failure.code === 'bank.cash_out_over_available') {
    return (
      <p data-testid="failure" role="alert">
        {t('overAvailable')} <small className="lt-hint">{t('reference', { code: failure.code })}</small>
      </p>
    );
  }
  return <FailureNote result={failure} retry={retry} />;
}

type FailKey = Extract<Key, `fail_${string}`>;
type ReturnKey = Extract<Key, `return_${string}`>;
type CancelKey = Extract<Key, `cancel_${string}`>;
const CANCEL_KEYS: Record<string, CancelKey> = {
  'bank.payout_cancelled_by_bank': 'cancel_bank_payout_cancelled_by_bank',
  'bank.payout_cancelled_compliance': 'cancel_bank_payout_cancelled_compliance',
};
const FAIL_KEYS: Record<string, FailKey> = {
  'bank.payout_account_closed': 'fail_bank_payout_account_closed',
  'bank.payout_name_mismatch': 'fail_bank_payout_name_mismatch',
  'bank.payout_rejected': 'fail_bank_payout_rejected',
};
const RETURN_KEYS: Record<string, ReturnKey> = {
  'bank.payout_returned_account_closed': 'return_bank_payout_returned_account_closed',
  'bank.payout_returned_by_bank': 'return_bank_payout_returned_by_bank',
};
const STATUS_KEYS = {
  refused: 'status_refused',
  processing: 'status_processing',
  completed: 'status_completed',
  failed: 'status_failed',
  cancelled: 'status_cancelled',
  returned: 'status_returned',
} as const satisfies Record<CashOutRequest['status'], Key>;

type LoadReceipt = (requestId: string) => Promise<ApiResult<CashOutReceipt>>;

/** Hands the receipt to the browser as a file, named as the service named it. */
function saveFile(receipt: CashOutReceipt) {
  const url = URL.createObjectURL(new Blob([receipt.text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = receipt.fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The signed receipt of a cash-out that was paid out: downloaded as a file, with its ledger record and hash beside it. */
function ReceiptPanel({ requestId, load }: { requestId: string; load?: LoadReceipt }) {
  const { t } = cashOutCopy.useCopy();
  const [receipt, setReceipt] = useState<ApiResult<CashOutReceipt> | 'loading' | null>(null);
  async function download() {
    if (!load) return;
    setReceipt('loading');
    const result = await load(requestId);
    setReceipt(result);
    if (result.ok) saveFile(result.data);
  }
  return (
    <div data-testid="cash-out-receipt">
      <Button tone="secondary" disabled={!load || receipt === 'loading'} onClick={() => void download()}>
        {t('receipt')}
      </Button>
      {receipt && receipt !== 'loading' && receipt.ok ? (
        <p className="lt-hint">
          {receipt.data.ledgerTxId !== null ? (
            <span data-testid="cash-out-receipt-ledger">{t('receiptLedger', { id: receipt.data.ledgerTxId })}</span>
          ) : (
            <span data-testid="cash-out-receipt-partner">{t('receiptPartner', { id: receipt.data.partnerMoveId ?? '' })}</span>
          )}
          <br />
          <span data-testid="cash-out-receipt-hash">{t('receiptHash', { hash: receipt.data.sha256 })}</span>
          <br />
          <span>{t('receiptSigned', { signature: receipt.data.signature })}</span>
        </p>
      ) : null}
      {receipt && receipt !== 'loading' && !receipt.ok ? (
        <p data-testid="failure" role="alert">
          {t('receiptFailed')} <small className="lt-hint">{t('reference', { code: receipt.code ?? '' })}</small>
        </p>
      ) : null}
    </div>
  );
}

/**
 * What came back of a cash-out the bank did not pay: once, to the balance it left, or, when the partner bank never took
 * it (no move under its key), that nothing left the balance.
 */
function backWords(row: CashOutRequest, amount: string, t: ReturnType<typeof cashOutCopy.useCopy>['t']): string {
  if (!row.heldAt) return t('failedBack', { amount });
  return row.partnerMoveId ? t('failedBackAt', { amount, label: row.heldAt }) : t('nothingTaken');
}

/** Where one cash-out stands: the tracker while the bank has it, then its receipt, or why it failed or came back. */
function Progress({ row, load }: { row: CashOutRequest; load?: LoadReceipt }) {
  const { t } = cashOutCopy.useCopy();
  const amount = funds(row.amount, row.assetId);
  if (row.status === 'refused') {
    return (
      <>
        <small className="lt-hint">
          {row.rail} · {t('reference', { code: row.refusalCode ?? '' })}
        </small>
        <small className="lt-hint" data-testid="cash-out-no-receipt">
          {t('noReceipt_refused')}
        </small>
      </>
    );
  }
  const failed = row.status === 'failed';
  const cancelled = row.status === 'cancelled';
  // Where the money comes back to: the partner bank's balance when it holds it, else the available balance.
  const at = row.heldAt;
  const steps = [t('status_processing'), t('status_completed')];
  const step = row.status === 'processing' ? 1 : 2;
  return (
    <>
      {!failed && !cancelled && (
        <ol
          className="lt-steps"
          data-testid="cash-out-steps"
          aria-label={t('step', { status: t(STATUS_KEYS[row.status]), n: step, of: 2 })}
        >
          {steps.map((name, i) => (
            <li
              key={name}
              className="lt-step"
              data-step={i < step - 1 ? 'done' : i === step - 1 ? 'current' : 'todo'}
              aria-current={i === step - 1 ? 'step' : undefined}
              data-off={i >= step ? 'true' : undefined}
            >
              <span>{i + 1}</span>
              {name}
            </li>
          ))}
        </ol>
      )}
      {row.receiveAmount && row.receiveCurrency && (
        <small className="lt-hint">{t('arrives', { amount: funds(row.receiveAmount, row.receiveCurrency) })}</small>
      )}
      {row.payoutRef && <small className="lt-hint">{t('payoutRef', { ref: row.payoutRef })}</small>}
      {row.status === 'processing' && (
        <>
          <small className="lt-hint">{t('noCancel')}</small>
          <small className="lt-hint" data-testid="cash-out-no-receipt">
            {t('noReceipt_processing')}
          </small>
        </>
      )}
      {failed && (
        <>
          <span data-testid="cash-out-why">
            {t(FAIL_KEYS[row.failureCode ?? ''] ?? 'fail_other')} {backWords(row, amount, t)}{' '}
            <small className="lt-hint">{t('reference', { code: row.failureCode ?? '' })}</small>
          </span>
          <small className="lt-hint" data-testid="cash-out-no-receipt">
            {t('noReceipt_failed')}
          </small>
        </>
      )}
      {cancelled && (
        <>
          <span data-testid="cash-out-why">
            {t(CANCEL_KEYS[row.failureCode ?? ''] ?? 'cancel_other')} {backWords(row, amount, t)}{' '}
            <small className="lt-hint">{t('reference', { code: row.failureCode ?? '' })}</small>
          </span>
          <small className="lt-hint" data-testid="cash-out-no-receipt">
            {t('noReceipt_cancelled')}
          </small>
        </>
      )}
      {row.status === 'returned' && row.returnedAmount && (
        <span data-testid="cash-out-why">
          {t(RETURN_KEYS[row.failureCode ?? ''] ?? 'return_other')}{' '}
          {row.returnedAmount === row.amount
            ? at
              ? t('returnedAllAt', { amount, label: at })
              : t('returnedAll', { amount })
            : t(at ? 'returnedPartAt' : 'returnedPart', {
                back: funds(row.returnedAmount, row.assetId),
                amount,
                kept: funds(row.remainsPaidOut ?? '', row.assetId),
                label: at ?? '',
              })}{' '}
          <small className="lt-hint">{t('reference', { code: row.failureCode ?? '' })}</small>
        </span>
      )}
      {(row.status === 'completed' || row.status === 'returned') && <ReceiptPanel requestId={row.requestId} load={load} />}
    </>
  );
}

export function RequestRows({ rows, load }: { rows: readonly CashOutRequest[]; load?: LoadReceipt }) {
  const { t } = cashOutCopy.useCopy();
  if (rows.length === 0) return <p className="lt-hint">{t('noRequests')}</p>;
  return (
    <dl className="lt-kv">
      {rows.map((row) => (
        <div key={row.requestId} data-testid="cash-out-request" data-status={row.status}>
          <dt>
            <strong>{t(STATUS_KEYS[row.status])}</strong> <small>{date(row.createdAt)}</small>
          </dt>
          <dd>
            <span className="lt-mono" dir="ltr">
              {funds(row.amount, row.assetId)}
            </span>{' '}
            <span>
              <Progress row={row} load={load} />
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Requests() {
  const { t } = cashOutCopy.useCopy();
  const { api } = useSession();
  const read = useBankRecord(BANK_CASH_OUT_REQUESTS, { limit: 20 });
  const { resource } = read;
  const load: LoadReceipt = (requestId) => api.call(BANK_CASH_OUT_RECEIPT, { requestId });
  return (
    <Panel title={t('requestsTitle')} lead={t('requestsLead')}>
      <div data-testid="cash-out-requests">
        {resource.status === 'loading' ? (
          <Skeleton shape="rows" />
        ) : resource.status === 'failed' ? (
          <FailureNote result={resource.failure} retry={read.reload} />
        ) : (
          <RequestRows rows={resource.data} load={load} />
        )}
      </div>
    </Panel>
  );
}

/** `/bank/ramps/cash-out`: cash out to one of the person's linked bank accounts. */
export function CashOut() {
  const { t } = cashOutCopy.useCopy();
  const { api, profiles } = useSession();
  const currencies = useBankRead('currencies.list', { profile: profiles.active });
  const linked = useBankRecord(BANK_LINKED_ACCOUNTS_LIST, undefined);
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
  const quote = useBankRecord(BANK_CASH_OUT_QUOTE, ask ?? NO_ASK, ask !== null);
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
    <div data-testid="cash-out">
      <Panel title={t('askTitle')}>
        {loading ? (
          <Skeleton shape="rows" />
        ) : currencies.resource.status === 'failed' ? (
          <FailureNote result={currencies.resource.failure} retry={currencies.reload} />
        ) : linked.resource.status === 'failed' ? (
          <FailureNote result={linked.resource.failure} retry={linked.reload} />
        ) : assets.length === 0 ? (
          <p className="lt-hint">{t('noCurrency')}</p>
        ) : accounts.length === 0 ? (
          <div>
            <p className="lt-hint">{t('noAccounts')}</p>
            <div className="lt-actions">
              <a className="lt-button lt-button-primary" href="/bank/ramps/accounts">
                {t('linkOne')}
              </a>
            </div>
          </div>
        ) : (
          <div>
            <label className="lt-field" htmlFor={assetField}>
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
            <label className="lt-field" htmlFor={accountField}>
              <span>{t('account')}</span>
              <select id={accountField} value={account} onChange={(event) => setAccountId(event.target.value)}>
                {accounts.map((row) => (
                  <option key={row.accountId} value={row.accountId}>
                    {row.label} ({row.ibanMasked})
                  </option>
                ))}
              </select>
            </label>
            <div className="lt-actions">
              <Button tone="primary" onClick={see}>
                {t('see')}
              </Button>
            </div>
          </div>
        )}
      </Panel>

      {ask && (
        <Panel title={t('quoteTitle')}>
          {quote.resource.status === 'loading' ? (
            <Skeleton shape="rows" />
          ) : quote.resource.status === 'failed' ? (
            <QuoteFailure failure={quote.resource.failure} retry={quote.reload} />
          ) : (
            <div>
              <QuoteView quote={quote.resource.data} />
              {/* A cash-out on its way closes this quote: another one starts from See, never from a stale price. */}
              {(!outcome || outcome.status === 'refused') && (
                <div className="lt-actions">
                  <Button tone="primary" onClick={() => setConfirming(true)}>
                    {t('confirm')}
                  </Button>
                </div>
              )}
              {outcome &&
                (outcome.status === 'refused' ? (
                  <div role="status" data-testid="cash-out-kept">
                    <h3>{t('keptTitle')}</h3>
                    <p>{t('keptBody')}</p>
                    <p>
                      <BlockerWords
                        code={outcome.refusalCode ?? ''}
                        rail={outcome.rail}
                        coolingOffEndsAt={quote.resource.data.account.coolingOffEndsAt}
                      />
                    </p>
                  </div>
                ) : (
                  <div role="status" data-testid="cash-out-sent">
                    <h3>{t('sentTitle')}</h3>
                    <p>{outcome.heldAt ? t('sentBodyAt', { label: outcome.heldAt }) : t('sentBody')}</p>
                  </div>
                ))}
            </div>
          )}
        </Panel>
      )}

      {confirming && ask && (
        <StepUpSheet
          why={t('confirmWhy')}
          run={async (token) => {
            const answer = await api.call(BANK_CASH_OUT_START, { requestId, ...ask }, { bearer: token });
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
      <div className="lt-actions">
        <a className="lt-link" href="/bank/ramps">
          {t('back')}
        </a>
      </div>
    </div>
  );
}
