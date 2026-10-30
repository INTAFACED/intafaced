import { useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { Button, DataTable, EmptyState, Failure, Loading } from '../../shared/ui';
import { useResource, type Resource } from '../../shared/resource';
import { decimalSchema, displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../session/session';
import { marketPurchasesCopy as copy } from './market-purchases-copy';
import './market-purchases.css';

const id = z.string().guid();
const time = z.string().datetime({ offset: true });
// Mounted Market purchase rows are decimal strings and native asset identifiers.
const purchase = z.object({
  id,
  listingId: id,
  buyerId: id,
  vendorId: id,
  vendorUserId: id,
  assetId: z
    .string()
    .min(1)
    .max(32)
    .refine((value) => value.trim().length > 0),
  price: decimalSchema,
  commissionBps: z.number().int().safe().min(0).max(10000),
  status: z.enum(['pending', 'settled', 'rejected', 'held', 'released', 'refunded']),
  ledgerTxId: id.nullable(),
  rejectionCode: z.string().nullable(),
  createdAt: time,
  settledAt: time.nullable(),
  accessUntil: time.nullable(),
  // A held purchase (MC-market-02): its refund window and the buyer's refund request.
  refundWindowEndsAt: time.nullable().optional(),
  refundRequestedAt: time.nullable().optional(),
});
export type MarketPurchaseRecord = z.infer<typeof purchase>;
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
  const parsed = resource.status === 'ready' ? z.array(purchase).max(Math.min(50, limit)).safeParse(resource.data) : null;
  const valid =
    parsed?.success &&
    parsed.data.every(
      (row, index) => row.buyerId === userId && (!index || Date.parse(row.createdAt) <= Date.parse(parsed.data[index - 1]!.createdAt)),
    ) &&
    new Set(parsed.data.map((row) => row.id)).size === parsed.data.length;
  const rows = valid && parsed?.success ? parsed.data : null;
  const current = rows?.find((row) => row.id === selected);
  useEffect(() => {
    if (selected) document.getElementById(`market-receipt-${selected}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    <section className="market-purchases" aria-label={t('title')} lang={languageFor('title')}>
      <p className="market-purchases-description">
        <Copy k="meaning" />
      </p>
      <div className="market-purchases-columns">
        <div className="market-purchases-list">
          <header className="market-purchases-controls">
            <h3>
              <Copy k="newest" />
            </h3>
            <Button variant="secondary" onClick={reload}>
              <Copy k="refresh" />
            </Button>
          </header>
          {resource.status === 'loading' ? (
            <Loading />
          ) : resource.status === 'failed' ? (
            <div lang="und">
              <Failure result={resource.failure} retry={reload} />
            </div>
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
                <DataTable
                  label={t('title')}
                  headers={[t('listingColumn'), t('priceColumn'), t('refundWindowColumn'), t('statusColumn'), t('actionsColumn')]}
                >
                  {rows.map((row) => {
                    const title = titleOf?.(row.listingId);
                    return (
                      <tr key={row.id}>
                        <td>{title ? <span lang="und">{title}</span> : <code lang="zxx">{row.listingId}</code>}</td>
                        <td className="numeric">
                          {hideBalances ? <span aria-label={t('amountHidden')}>••••</span> : displayAmount(row.price)}{' '}
                          <span lang="zxx">{row.assetId}</span>
                        </td>
                        <td>{row.refundWindowEndsAt ? <Timestamp value={row.refundWindowEndsAt} /> : <Copy k="noRefundWindow" />}</td>
                        <td>
                          <Copy k={statusKey(row)} />
                        </td>
                        <td>
                          <div className="market-purchases-row-actions">
                            {hasReceipt(row) ? (
                              <a
                                className="text-link"
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
                              <Button variant="secondary" aria-pressed={selected === row.id} onClick={() => setSelected(row.id)}>
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
                </DataTable>
              ) : (
                <EmptyState title={t('noRows')}>
                  <Copy k="noRowsBody" />
                </EmptyState>
              )}
              <p className="market-purchases-description">
                <Copy k="window" params={{ count: rows.length, limit: Math.min(50, limit) }} />
              </p>
            </>
          )}
        </div>
        {selected && (
          <section className="market-purchases-inspection" id={`market-receipt-${selected}`} aria-label={t('selected')}>
            <header className="market-purchases-controls">
              <h3>
                <Copy k="selected" />
              </h3>
              <Button variant="ghost" onClick={() => setSelected(null)}>
                <Copy k="hide" />
              </Button>
            </header>
            <p className="market-purchases-reference" lang="zxx">
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
                <p className="market-purchases-description">
                  <Copy k="missingMeaning" />
                </p>
              </>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
function Timestamp({ value }: { value: string }) {
  const { requestedLocale } = copy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <time className="market-purchases-time" dateTime={value} lang={requestedLocale}>
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
      <div className="market-purchases-settlement">
        <h3>
          <Copy k={recorded ? 'recorded' : rejected ? 'rejected' : 'unconfirmed'} />
        </h3>
        <p className="market-purchases-description">
          <Copy k={recorded ? 'recordedBody' : rejected ? 'rejectedBody' : 'unconfirmedBody'} />
        </p>
      </div>
      <div className="market-purchases-value">
        <p className="market-purchases-description">
          <Copy k="price" />
        </p>
        <div className="market-purchases-exact-price" tabIndex={0} role="group" aria-label={t('price')}>
          <strong className="numeric">{hideBalances ? <span aria-label={t('amountHidden')}>••••</span> : displayAmount(row.price)}</strong>
        </div>
        <span lang="zxx">{row.assetId}</span>
        {hideBalances && (
          <p className="market-purchases-description">
            <Copy k="hidden" />
          </p>
        )}
      </div>
      <dl className="market-purchases-facts">
        {fact('purchase', <span lang="zxx">{row.id}</span>)}
        {row.ledgerTxId && fact('ledger', <span lang="zxx">{row.ledgerTxId}</span>)}
        {fact('listing', <span lang="zxx">{row.listingId}</span>)}
        {fact('originalWindow', row.accessUntil ? <Timestamp value={row.accessUntil} /> : <Copy k="noWindow" />)}
        {row.rejectionCode && fact('rejection', <span lang="zxx">{row.rejectionCode}</span>)}
      </dl>
      <details className="market-purchases-extra">
        <summary>
          <Copy k="more" />
        </summary>
        <dl className="market-purchases-facts">
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
        <p className="market-purchases-description">
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
        ? api.query(
            'market',
            'subscriptionAccess',
            { listingId: row.listingId },
            z
              .object({ granted: z.literal(true), listingId: id, buyerId: id, accessUntil: time })
              .refine(
                (value) => value.buyerId === userId && value.listingId === row.listingId,
                'Current access ownership or listing identity is invalid',
              ),
            { signal },
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
    <section className="market-purchases-access" aria-label={t('currentAccess')}>
      <h4>
        <Copy k="currentAccess" />
      </h4>
      <p className="market-purchases-description">
        <Copy k="accessMeaning" />
      </p>
      {!requested ? (
        <p>
          <Copy k="unchecked" />
        </p>
      ) : access.resource.status === 'loading' ? (
        <Loading label={<Copy k="checking" />} />
      ) : failure ? (
        <div className="market-purchases-access-outcome" role="status">
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
              <Failure result={failure} />
            </div>
          )}
          {failure.code && (
            <p>
              <Copy k="serviceCode" />: <span lang="zxx">{failure.code}</span>
            </p>
          )}
        </div>
      ) : access.resource.status === 'ready' && access.resource.data ? (
        <div className="market-purchases-access-outcome" role="status">
          <h4>
            <Copy k="grant" />
          </h4>
          <dl className="market-purchases-facts">
            <div>
              <dt>
                <Copy k="currentWindow" />
              </dt>
              <dd>
                <Timestamp value={access.resource.data.accessUntil} />
              </dd>
            </div>
          </dl>
          <p className="market-purchases-description">
            <Copy k="grantMeaning" />
          </p>
        </div>
      ) : null}
      <Button
        variant="secondary"
        disabled={requested && access.resource.status === 'loading'}
        onClick={() => {
          setRequested(true);
          setCycle((value) => value + 1);
        }}
      >
        <Copy k="check" />
      </Button>
      <p className="market-purchases-description">
        <Copy k="separate" />
      </p>
    </section>
  );
}
