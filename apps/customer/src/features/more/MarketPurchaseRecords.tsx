import { useEffect, useState, type ReactNode } from 'react';
import { MARKET_SUBSCRIPTION_ACCESS, type MarketPurchase } from '@intafaced/contracts/market-procedures';
import { Button } from '@intafaced/ui/lit';
import { useResource, type Resource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../session';
import { marketPurchasesCopy as copy } from './market-purchases-copy';
import { EmptyNote, FailureNote, ScrollTable, Waiting } from './volt-parts';

export type MarketPurchaseRecord = MarketPurchase;
type Props = {
  resource: Resource<MarketPurchaseRecord[]>;
  reload: () => void;
  limit: number;
  renderCancel: (row: MarketPurchaseRecord) => ReactNode;
  /** The listing's title from the catalogue, when it is loaded. */
  titleOf?: (listingId: string) => string | undefined;
  renderRefund?: (row: MarketPurchaseRecord) => ReactNode;
  /** The named blocker shown with the refund control on a held row (the refund policy is not set). */
  refundNote?: ReactNode;
};
type StatusKey =
  'statusPending' | 'statusSettled' | 'statusRejected' | 'statusHeld' | 'statusRefundRequested' | 'statusReleased' | 'statusRefunded';
const statusKey = (row: MarketPurchaseRecord): StatusKey =>
  row.status === 'held'
    ? row.refundRequestedAt
      ? 'statusRefundRequested'
      : 'statusHeld'
    : row.status === 'pending'
      ? 'statusPending'
      : row.status === 'settled'
        ? 'statusSettled'
        : row.status === 'rejected'
          ? 'statusRejected'
          : row.status === 'released'
            ? 'statusReleased'
            : 'statusRefunded';
/** A receipt is offered only for money that reached the seller: never for a pending, held or refunded purchase. */
const hasReceipt = (row: MarketPurchaseRecord) =>
  (row.status === 'settled' || row.status === 'released') && row.ledgerTxId !== null && row.settledAt !== null;
type Fact =
  | 'purchase'
  | 'ledger'
  | 'listing'
  | 'buyer'
  | 'vendor'
  | 'vendorUser'
  | 'commission'
  | 'created'
  | 'settled'
  | 'originalWindow'
  | 'status'
  | 'rejection';

/** Actor changes discard selection and every private access read. */
export function MarketPurchaseRecords(props: Props) {
  const { userId } = useSession();
  return userId ? <OwnerRecords key={userId} userId={userId} {...props} /> : null;
}
function OwnerRecords({ userId, resource, reload, limit, renderCancel, titleOf, renderRefund, refundNote }: Props & { userId: string }) {
  const { Copy, t, languageFor } = copy.useCopy();
  const { hideBalances } = usePreferences();
  const [selected, setSelected] = useState<string | null>(null);
  // The rows were read through MARKET_MY_PURCHASES; here they must also be this person's, one page, newest first, each once.
  const read = resource.status === 'ready' ? resource.data : null;
  const valid =
    read !== null &&
    read.length <= Math.min(50, limit) &&
    read.every((row, index) => row.buyerId === userId && (!index || Date.parse(row.createdAt) <= Date.parse(read[index - 1]!.createdAt))) &&
    new Set(read.map((row) => row.id)).size === read.length;
  const rows = valid ? read : null;
  const current = rows?.find((row) => row.id === selected);
  useEffect(() => {
    if (selected) document.getElementById(`market-receipt-${selected}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    <section className="lt-stack" aria-label={t('title')} lang={languageFor('title')}>
      <p className="lt-hint">
        <Copy k="meaning" />
      </p>
      <div className="lt-grid lt-grid-main-side">
        <div className="lt-col-main lt-stack">
          <header className="lt-toolbar">
            <h3>
              <Copy k="newest" />
            </h3>
            <Button tone="secondary" onClick={reload}>
              <Copy k="refresh" />
            </Button>
          </header>
          {resource.status === 'loading' ? (
            <Waiting />
          ) : resource.status === 'failed' ? (
            <div lang="und">
              <FailureNote result={resource.failure} retry={reload} />
            </div>
          ) : !rows ? (
            <div className="lt-refusal" role="alert">
              <h3 className="lt-refusal-title">
                <Copy k="invalid" />
              </h3>
              <p className="lt-refusal-body">
                <Copy k="invalidBody" />
              </p>
            </div>
          ) : (
            <>
              {rows.length ? (
                <ScrollTable
                  label={t('title')}
                  headers={[t('listingColumn'), t('priceColumn'), t('refundWindowColumn'), t('statusColumn'), t('actionsColumn')]}
                >
                  {rows.map((row) => {
                    const title = titleOf?.(row.listingId);
                    return (
                      <tr key={row.id}>
                        <td>{title ? <span lang="und">{title}</span> : <code lang="zxx">{row.listingId}</code>}</td>
                        <td className="lt-num">
                          {hideBalances ? <span aria-label={t('amountHidden')}>••••</span> : displayAmount(row.price)}{' '}
                          <span lang="zxx">{row.assetId}</span>
                        </td>
                        <td>{row.refundWindowEndsAt ? <Timestamp value={row.refundWindowEndsAt} /> : <Copy k="noRefundWindow" />}</td>
                        <td>
                          <Copy k={statusKey(row)} />
                        </td>
                        <td>
                          <div className="lt-actions">
                            {hasReceipt(row) ? (
                              <a
                                className="lt-link"
                                href={`#market-receipt-${row.id}`}
                                aria-current={selected === row.id ? 'true' : undefined}
                                onClick={(event) => {
                                  // The room keeps its own address: a fragment change would retire the Market action in flight.
                                  event.preventDefault();
                                  setSelected(row.id);
                                }}
                              >
                                <Copy k="receipt" />
                              </a>
                            ) : (
                              <Button tone="secondary" aria-pressed={selected === row.id} onClick={() => setSelected(row.id)}>
                                <Copy k="inspect" />
                              </Button>
                            )}
                            {row.status === 'held' && renderRefund?.(row)}
                            {row.status === 'held' && refundNote}
                            {row.accessUntil && renderCancel(row)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </ScrollTable>
              ) : (
                <EmptyNote title={t('noRows')}>
                  <Copy k="noRowsBody" />
                </EmptyNote>
              )}
              <p className="lt-hint">
                <Copy k="window" params={{ count: rows.length, limit: Math.min(50, limit) }} />
              </p>
            </>
          )}
        </div>
        <div className="lt-col-side">
          {selected && (
            <section className="lt-stack" id={`market-receipt-${selected}`} aria-label={t('selected')}>
              <header className="lt-toolbar">
                <h3>
                  <Copy k="selected" />
                </h3>
                <Button tone="quiet" onClick={() => setSelected(null)}>
                  <Copy k="hide" />
                </Button>
              </header>
              <p className="lt-mono lt-wrap" lang="zxx">
                {selected}
              </p>
              {current ? (
                <OriginalRecord
                  key={JSON.stringify([
                    userId,
                    current.id,
                    current.listingId,
                    current.status,
                    current.price,
                    current.ledgerTxId,
                    current.settledAt,
                    current.accessUntil,
                  ])}
                  row={current}
                />
              ) : (
                <>
                  <p>
                    <Copy k="missing" />
                  </p>
                  <p className="lt-hint">
                    <Copy k="missingMeaning" />
                  </p>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
function Timestamp({ value }: { value: string }) {
  const { requestedLocale } = copy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <time className="lt-muted" dateTime={value} lang={requestedLocale}>
      {new Intl.DateTimeFormat(requestedLocale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        ...(timeZone === 'device' ? {} : { timeZone: timeZone === 'UTC+8' ? 'Asia/Makassar' : 'UTC' }),
      }).format(new Date(value))}{' '}
      · {timeZone === 'device' ? Intl.DateTimeFormat().resolvedOptions().timeZone : timeZone}
    </time>
  );
}
function OriginalRecord({ row }: { row: MarketPurchaseRecord }) {
  const { Copy, t } = copy.useCopy();
  const { hideBalances } = usePreferences();
  const recorded = (row.status === 'settled' || row.status === 'released') && row.ledgerTxId !== null && row.settledAt !== null;
  const rejected = row.status === 'rejected' && Boolean(row.rejectionCode) && row.ledgerTxId === null && row.settledAt === null;
  function fact(label: Fact, value: ReactNode) {
    return (
      <div>
        <dt>
          <Copy k={label} />
        </dt>
        <dd>{value}</dd>
      </div>
    );
  }
  return (
    <>
      <div className="lt-stack">
        <h3>
          <Copy k={recorded ? 'recorded' : rejected ? 'rejected' : 'unconfirmed'} />
        </h3>
        <p className="lt-hint">
          <Copy k={recorded ? 'recordedBody' : rejected ? 'rejectedBody' : 'unconfirmedBody'} />
        </p>
      </div>
      <div className="lt-stack">
        <p className="lt-hint">
          <Copy k="price" />
        </p>
        <div tabIndex={0} role="group" aria-label={t('price')}>
          <strong className="lt-num">{hideBalances ? <span aria-label={t('amountHidden')}>••••</span> : displayAmount(row.price)}</strong>
        </div>
        <span lang="zxx">{row.assetId}</span>
        {hideBalances && (
          <p className="lt-hint">
            <Copy k="hidden" />
          </p>
        )}
      </div>
      <dl className="lt-kv">
        {fact('purchase', <span lang="zxx">{row.id}</span>)}
        {row.ledgerTxId && fact('ledger', <span lang="zxx">{row.ledgerTxId}</span>)}
        {fact('listing', <span lang="zxx">{row.listingId}</span>)}
        {fact('originalWindow', row.accessUntil ? <Timestamp value={row.accessUntil} /> : <Copy k="noWindow" />)}
        {row.rejectionCode && fact('rejection', <span lang="zxx">{row.rejectionCode}</span>)}
      </dl>
      <details>
        <summary>
          <Copy k="more" />
        </summary>
        <dl className="lt-kv">
          {fact('status', <span lang="zxx">{row.status}</span>)}
          {fact('buyer', <span lang="zxx">{row.buyerId}</span>)}
          {fact('vendor', <span lang="zxx">{row.vendorId}</span>)}
          {fact('vendorUser', <span lang="zxx">{row.vendorUserId}</span>)}
          {fact('commission', <span lang="zxx">{row.commissionBps}</span>)}
          {fact('created', <Timestamp value={row.createdAt} />)}
          {row.settledAt && fact('settled', <Timestamp value={row.settledAt} />)}
        </dl>
      </details>
      {!row.accessUntil && (
        <p className="lt-hint">
          <Copy k="noSubscriptionWindow" />
        </p>
      )}
      <CurrentAccess row={row} />
    </>
  );
}
function CurrentAccess({ row }: { row: MarketPurchaseRecord }) {
  const { api, userId } = useSession();
  const { Copy, t } = copy.useCopy();
  const [requested, setRequested] = useState(false);
  const [cycle, setCycle] = useState(0);
  // Read-only, manual, owned listing check. Its aggregate paid window is not an original-purchase outcome.
  const access = useResource(
    (signal) =>
      requested
        ? api.call(
            MARKET_SUBSCRIPTION_ACCESS,
            { listingId: row.listingId },
            { signal, accept: (value) => value.buyerId === userId && value.listingId === row.listingId },
          )
        : Promise.resolve({ ok: true as const, data: null }),
    `market-current-access:${userId}:${row.id}:${row.listingId}:${requested}:${cycle}`,
  );
  const failure = access.resource.status === 'failed' ? access.resource.failure : null;
  const refusalKey =
    failure?.code === 'market.subscription_past_due'
      ? 'pastDue'
      : failure?.code === 'market.subscription_cancelled'
        ? 'cancelled'
        : failure?.code === 'market.subscription_no_access'
          ? 'noAccess'
          : failure?.code === 'market.listing_not_found'
            ? 'notSubscription'
            : null;
  return (
    <section className="lt-stack" aria-label={t('currentAccess')}>
      <h4>
        <Copy k="currentAccess" />
      </h4>
      <p className="lt-hint">
        <Copy k="accessMeaning" />
      </p>
      {!requested ? (
        <p>
          <Copy k="unchecked" />
        </p>
      ) : access.resource.status === 'loading' ? (
        <Waiting label={<Copy k="checking" />} />
      ) : failure ? (
        <div className="lt-stack" role="status">
          <h4>
            <Copy k="accessUnavailable" />
          </h4>
          {refusalKey && (
            <p>
              <Copy k={refusalKey} />
            </p>
          )}
          {refusalKey ? (
            <p lang="und">{failure.message}</p>
          ) : (
            <div lang="und">
              <FailureNote result={failure} />
            </div>
          )}
          {failure.code && (
            <p>
              <Copy k="serviceCode" />: <span lang="zxx">{failure.code}</span>
            </p>
          )}
        </div>
      ) : access.resource.status === 'ready' && access.resource.data ? (
        <div className="lt-stack" role="status">
          <h4>
            <Copy k="grant" />
          </h4>
          <dl className="lt-kv">
            <div>
              <dt>
                <Copy k="currentWindow" />
              </dt>
              <dd>
                <Timestamp value={access.resource.data.accessUntil} />
              </dd>
            </div>
          </dl>
          <p className="lt-hint">
            <Copy k="grantMeaning" />
          </p>
        </div>
      ) : null}
      <Button
        tone="secondary"
        disabled={requested && access.resource.status === 'loading'}
        onClick={() => {
          setRequested(true);
          setCycle((value) => value + 1);
        }}
      >
        <Copy k="check" />
      </Button>
      <p className="lt-hint">
        <Copy k="separate" />
      </p>
    </section>
  );
}
