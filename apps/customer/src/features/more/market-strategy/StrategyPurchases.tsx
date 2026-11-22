import { useState, type ReactNode } from 'react';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { Skeleton, Table } from '@intafaced/ui/lit/templates';
import { MARKET_SUBSCRIPTION_ACCESS, type MarketPurchase } from '@intafaced/contracts/market-procedures';
import { useResource, type Resource } from '../../../shared/resource';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { useSession } from '../../session';
import { marketPurchasesCopy as copy } from '../market-purchases-copy';
import type { ApiResult } from '../../../shared/api';
import { readRefusal } from './read-refusal';
import { Retry } from './StrategyParts';

/**
 * The person's own Market purchases on the Volt kit: the same rows, checks, receipt inspection and access read the old
 * purchase records (MarketPurchaseRecords.tsx) draw. A read that failed is named by the room's refusal; here it keeps its
 * place and offers "Try again".
 */
type Props = {
  resource: Resource<MarketPurchase[]>;
  reload: () => void;
  limit: number;
  renderCancel: (row: MarketPurchase) => ReactNode;
  titleOf?: (listingId: string) => string | undefined;
  renderRefund?: (row: MarketPurchase) => ReactNode;
  refundNote?: ReactNode;
};
type StatusKey =
  'statusPending' | 'statusSettled' | 'statusRejected' | 'statusHeld' | 'statusRefundRequested' | 'statusReleased' | 'statusRefunded';
const statusKey = (row: MarketPurchase): StatusKey =>
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
const hasReceipt = (row: MarketPurchase) =>
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
export function StrategyPurchases(props: Props) {
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
  // The inspection opens beside the list; bring it into view once it is drawn.
  const select = (id: string) => {
    setSelected(id);
    requestAnimationFrame(() => document.getElementById(`market-receipt-${id}`)?.scrollIntoView?.({ block: 'nearest' }));
  };
  return (
    <section aria-label={t('title')} lang={languageFor('title')}>
      <p>
        <Copy k="meaning" />
      </p>
      <div>
        <header className="lt-toolbar">
          <h3>
            <Copy k="newest" />
          </h3>
          <Button tone="secondary" onClick={reload}>
            <Copy k="refresh" />
          </Button>
        </header>
        {resource.status === 'loading' ? (
          <Skeleton shape="rows" count={3} />
        ) : resource.status === 'failed' ? (
          <Retry failure={resource.failure} retry={reload} />
        ) : !rows ? (
          <div role="alert">
            <h3>
              <Copy k="invalid" />
            </h3>
            <p>
              <Copy k="invalidBody" />
            </p>
          </div>
        ) : (
          <>
            {rows.length ? (
              <Table
                caption={t('title')}
                rowKey={(row) => row.id}
                rows={rows}
                columns={[
                  {
                    key: 'listing',
                    label: t('listingColumn'),
                    cell: (row) => {
                      const title = titleOf?.(row.listingId);
                      return title ? <span lang="und">{title}</span> : <code lang="zxx">{row.listingId}</code>;
                    },
                  },
                  {
                    key: 'price',
                    label: t('priceColumn'),
                    align: 'end',
                    cell: (row) => (
                      <>
                        {hideBalances ? <span aria-label={t('amountHidden')}>••••</span> : displayAmount(row.price)}{' '}
                        <span lang="zxx">{row.assetId}</span>
                      </>
                    ),
                  },
                  {
                    key: 'window',
                    label: t('refundWindowColumn'),
                    cell: (row) => (row.refundWindowEndsAt ? <Timestamp value={row.refundWindowEndsAt} /> : <Copy k="noRefundWindow" />),
                  },
                  { key: 'status', label: t('statusColumn'), cell: (row) => <Copy k={statusKey(row)} /> },
                  {
                    key: 'actions',
                    label: t('actionsColumn'),
                    cell: (row) => (
                      <span className="lt-actions">
                        {hasReceipt(row) ? (
                          <a
                            className="lt-link"
                            href={`#market-receipt-${row.id}`}
                            aria-current={selected === row.id ? 'true' : undefined}
                            onClick={(event) => {
                              // The room keeps its own address: a fragment change would retire the Market action in flight.
                              event.preventDefault();
                              select(row.id);
                            }}
                          >
                            <Copy k="receipt" />
                          </a>
                        ) : (
                          <Button tone="secondary" aria-pressed={selected === row.id} onClick={() => select(row.id)}>
                            <Copy k="inspect" />
                          </Button>
                        )}
                        {row.status === 'held' && renderRefund?.(row)}
                        {row.status === 'held' && refundNote}
                        {row.accessUntil && renderCancel(row)}
                      </span>
                    ),
                  },
                ]}
              />
            ) : (
              <EmptyState title={t('noRows')} body={t('noRowsBody')} />
            )}
            <p>
              <Copy k="window" params={{ count: rows.length, limit: Math.min(50, limit) }} />
            </p>
          </>
        )}
      </div>
      {selected && (
        <section id={`market-receipt-${selected}`} aria-label={t('selected')}>
          <header className="lt-toolbar">
            <h3>
              <Copy k="selected" />
            </h3>
            <Button tone="quiet" onClick={() => setSelected(null)}>
              <Copy k="hide" />
            </Button>
          </header>
          <p className="lt-mono" lang="zxx">
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
              <p>
                <Copy k="missingMeaning" />
              </p>
            </>
          )}
        </section>
      )}
    </section>
  );
}
function Timestamp({ value }: { value: string }) {
  const { requestedLocale } = copy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <time dateTime={value} lang={requestedLocale}>
      {new Intl.DateTimeFormat(requestedLocale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        ...(timeZone === 'device' ? {} : { timeZone: timeZone === 'UTC+8' ? 'Asia/Makassar' : 'UTC' }),
      }).format(new Date(value))}{' '}
      · {timeZone === 'device' ? Intl.DateTimeFormat().resolvedOptions().timeZone : timeZone}
    </time>
  );
}
function OriginalRecord({ row }: { row: MarketPurchase }) {
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
      <div>
        <h3>
          <Copy k={recorded ? 'recorded' : rejected ? 'rejected' : 'unconfirmed'} />
        </h3>
        <p>
          <Copy k={recorded ? 'recordedBody' : rejected ? 'rejectedBody' : 'unconfirmedBody'} />
        </p>
      </div>
      <div>
        <p>
          <Copy k="price" />
        </p>
        <div tabIndex={0} role="group" aria-label={t('price')}>
          <strong className="lt-mono">{hideBalances ? <span aria-label={t('amountHidden')}>••••</span> : displayAmount(row.price)}</strong>
        </div>
        <span lang="zxx">{row.assetId}</span>
        {hideBalances && (
          <p>
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
        <p>
          <Copy k="noSubscriptionWindow" />
        </p>
      )}
      <CurrentAccess row={row} />
    </>
  );
}
function CurrentAccess({ row }: { row: MarketPurchase }) {
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
    <section aria-label={t('currentAccess')}>
      <h4>
        <Copy k="currentAccess" />
      </h4>
      <p>
        <Copy k="accessMeaning" />
      </p>
      {!requested ? (
        <p>
          <Copy k="unchecked" />
        </p>
      ) : access.resource.status === 'loading' ? (
        <p role="status">
          <Copy k="checking" />…
        </p>
      ) : failure ? (
        <div role="status">
          <h4>
            <Copy k="accessUnavailable" />
          </h4>
          {refusalKey && (
            <p>
              <Copy k={refusalKey} />
            </p>
          )}
          {refusalKey ? <p lang="und">{failure.message}</p> : <AccessFailure failure={failure} />}
          {failure.code && (
            <p>
              <Copy k="serviceCode" />: <span lang="zxx">{failure.code}</span>
            </p>
          )}
        </div>
      ) : access.resource.status === 'ready' && access.resource.data ? (
        <div role="status">
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
          <p>
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
      <p>
        <Copy k="separate" />
      </p>
    </section>
  );
}
/** An access read refused for a reason the room has no words of its own for: the app's words for that failure. */
function AccessFailure({ failure }: { failure: Extract<ApiResult<unknown>, { ok: false }> }) {
  const { language } = usePreferences();
  const refusal = readRefusal(failure, language, location.pathname + location.search);
  return (
    <div lang="und">
      <h4>{refusal.title}</h4>
      <p>{refusal.body}</p>
    </div>
  );
}
