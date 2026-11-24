import { useState } from 'react';
import { AmountField, Button, EmptyState, Field } from '@intafaced/ui/lit';
import { SelectField } from '@intafaced/ui/lit/templates';
import {
  BANK_BILLS_BILLERS_SEARCH,
  BANK_BILLS_LIST,
  BANK_BILLS_RECURRING_CREATE,
  BANK_BILLS_RECURRING_LIST,
} from '@intafaced/contracts/bank-bills-procedures';
import { useResource } from '../../shared/resource';
import { personalCopy } from './personal-copy';
import { payCopy } from './copy';
import { fmtAmount, refusalCopy, useSession } from './deps';
import { Reason, sourceLabel, Steps, useSources } from './journey';

/** The refusal a biller search gives while no directory answers for the person: no biller network is connected. */
const NOT_CONNECTED = 'bank.bills_directory_unset';

type Biller = { id: string; name: string };

/** A bill payment's status in the person's words. */
const STATUS_WORDS = {
  submitted: 'statusSubmitted',
  accepted: 'statusAccepted',
  paid: 'statusPaid',
  failed: 'billStatusFailed',
  returned: 'billStatusReturned',
} as const;

/**
 * Bill pay (/pay/bills). The billers come from the bill directory that answers for the person: where the partner bank
 * holds their money and pays bills, its own billers (each named TEST on a test stack). With none connected the search
 * says so and nothing can be set up. A bill is set up to be paid every month from one of the person's balances, from the
 * date they choose; each run is one payment the partner makes. The lists are the person's own, read from the bank.
 */
export function BillsCard() {
  const { t } = personalCopy.useCopy();
  const { api, userId } = useSession();
  const { sources, state } = useSources();
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [billerId, setBillerId] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [starts, setStarts] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const [attempt] = useState(() => crypto.randomUUID());

  const found = useResource<Biller[]>(
    (signal) =>
      asked === null ? Promise.resolve({ ok: true as const, data: [] }) : api.call(BANK_BILLS_BILLERS_SEARCH, { query: asked }, { signal }),
    `bills-billers:${userId}:${asked ?? ''}`,
  );
  const recurring = useResource((signal) => api.call(BANK_BILLS_RECURRING_LIST, { limit: 20 }, { signal }), `bills-recurring:${userId}`);
  const paid = useResource((signal) => api.call(BANK_BILLS_LIST, { limit: 20 }, { signal }), `bills-paid:${userId}`);

  const notConnected = found.resource.status === 'failed' && found.resource.failure.code === NOT_CONNECTED;
  const billers = found.resource.status === 'ready' ? found.resource.data : [];
  const fromId = from || sources[0]?.id || '';
  const ready = Boolean(billerId && reference.trim() && amount && fromId && starts) && !busy;
  const names = new Map(billers.map((b) => [b.id, b.name]));

  async function setUp() {
    setBusy(true);
    setOutcome(null);
    // One business key per bill the person sets up: the same press sent twice is the same bill.
    const result = await api.call(BANK_BILLS_RECURRING_CREATE, {
      idempotencyKey: `bill-recurring:${attempt}:${billerId}:${reference.trim()}:${starts}`,
      billerId,
      reference: reference.trim(),
      amount,
      fromSpaceId: fromId,
      cadence: 'monthly',
      startsAt: `${starts}T00:00:00.000Z`,
    });
    setBusy(false);
    if (result.ok) {
      setOutcome({ ok: true, text: t('billSetUpDone') });
      recurring.reload();
    } else {
      setOutcome({ ok: false, text: result.code ? refusalCopy(result.code).title : t('billSetUpFailed') });
    }
  }

  return (
    <div className="lt-stack" data-testid="bills-card">
      {notConnected ? <Reason title={t('billsReasonTitle')}>{t('billsReasonBody')}</Reason> : null}
      <Steps items={[t('stepBiller'), t('stepReference'), t('stepAmount'), t('stepReview'), t('stepStatus')]} />
      <form
        className="lt-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) setAsked(query.trim());
        }}
      >
        <Field
          id="bill-biller"
          label={t('billerLabel')}
          type="search"
          placeholder={t('billerPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <Button type="submit" disabled={!query.trim()} data-testid="bills-search">
          {t('billerSearch')}
        </Button>
      </form>
      <form
        className="lt-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) void setUp();
        }}
      >
        <fieldset className="lt-stack" disabled={notConnected || billers.length === 0}>
          <SelectField
            id="bill-pick"
            label={t('billerPick')}
            value={billerId}
            onChange={setBillerId}
            options={[
              {
                value: '',
                label: asked !== null && found.resource.status === 'ready' && billers.length === 0 ? t('billerNone') : t('billerPick'),
              },
              ...billers.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
          <Field
            id="bill-reference"
            label={t('billReferenceLabel')}
            type="text"
            placeholder={t('billReferencePlaceholder')}
            value={reference}
            onChange={(event) => setReference(event.currentTarget.value)}
          />
          <AmountField label={payCopy.t('Amount')} value={amount} onChange={setAmount} precision={18} placeholder="0" />
          <SelectField
            id="bill-from"
            label={t('payFrom')}
            value={fromId}
            onChange={setFrom}
            options={
              sources.length === 0
                ? [{ value: '', label: state === 'loading' ? '…' : t('payFromNone') }]
                : sources.map((row) => ({ value: row.id, label: sourceLabel(row) }))
            }
          />
          <Field
            id="bill-starts"
            label={t('billStarts')}
            type="date"
            value={starts}
            onChange={(event) => setStarts(event.currentTarget.value)}
          />
        </fieldset>
        <Button type="submit" tone="primary" size="lg" block disabled={!ready} data-testid="bills-review">
          {notConnected ? t('billsReviewOff') : t('billSetUp')}
        </Button>
        {outcome ? (
          <p role="status" data-testid="bills-outcome" data-state={outcome.ok ? 'ok' : 'refused'}>
            {outcome.text}
          </p>
        ) : null}
      </form>
      <div className="lt-stack">
        <h3>{t('billsStatus')}</h3>
        <Steps items={[t('statusSubmitted'), t('statusAccepted'), t('statusPaid')]} />
      </div>
      <div className="lt-stack">
        <h3>{t('billsHistory')}</h3>
        {paid.resource.status === 'ready' && paid.resource.data.items.length > 0 ? (
          <ul className="lt-stack" data-testid="bills-paid">
            {paid.resource.data.items.map((bill) => (
              <li key={bill.id} data-testid={`bill-payment-${bill.id}`} data-status={bill.status}>
                {names.get(bill.billerId) ?? bill.billerId} · {bill.reference} · {fmtAmount(bill.amount, { places: 8 })} {bill.assetId} ·{' '}
                {t(STATUS_WORDS[bill.status])}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={paid.resource.status === 'loading' ? '…' : t('billsHistoryEmpty')} />
        )}
        <h3>{t('billsRecurring')}</h3>
        {recurring.resource.status === 'ready' && recurring.resource.data.length > 0 ? (
          <ul className="lt-stack" data-testid="bills-recurring">
            {recurring.resource.data.map((bill) => (
              <li key={bill.id} id={`bill-${bill.id}`} data-testid={`bill-recurring-${bill.id}`} data-status={bill.status}>
                {names.get(bill.billerId) ?? bill.billerId} · {bill.reference} · {fmtAmount(bill.amount, { places: 8 })} {bill.assetId} ·{' '}
                {t('billNext', { date: bill.nextRunAt.slice(0, 10) })}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={recurring.resource.status === 'loading' ? '…' : t('billsRecurringEmpty')} />
        )}
      </div>
    </div>
  );
}
