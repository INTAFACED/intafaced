import { useMemo, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, DataTable, Field, Page } from '../../shared/ui';
import { createPersonalPayApi, type PersonalPayApi } from './pay-api';
import { PayDetails, PayNotice, PayPagination, PaySection, PayState, ReviewedAction, Status, MutationResult } from './components';
import { id, type Offer, type Trade } from './schemas';

export function P2P({ path }: { path: string }) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  const params = new URLSearchParams(
    path.includes('?') ? path.slice(path.indexOf('?')) : typeof location === 'undefined' ? '' : location.search,
  );
  const tradeId = params.get('tradeId') ?? params.get('id') ?? path.match(/^\/p2p\/orders\/([^/?]+)/)?.[1];
  const current = path.split('?')[0];
  const showOrders = current === '/uc/order' || current === '/p2p/orders';
  const showMine = current === '/uc/ad' || current === '/p2p/offers';
  const showMethods = current === '/p2p/methods' || params.get('view') === 'methods';
  const showAccess = params.get('view') === 'access';
  const publish = current === '/uc/ad/create' || current === '/uc/ad/update' || current === '/p2p/offers/new';
  const counterparty = params.get('userId') ?? params.get('userid');
  return (
    <Page
      eyebrow="Personal Pay"
      title={
        current === '/chat' || tradeId
          ? 'P2P order'
          : current === '/checkuser'
            ? 'Counterparty'
            : publish
              ? 'Create an offer'
              : 'Person-to-person'
      }
      description="External payment, ledger escrow, and a recorded order status."
    >
      <nav className="pay-room-tabs" aria-label="P2P rooms">
        <a href="/p2p" aria-current={!showOrders && !showMine && !showMethods && !showAccess && !publish && !tradeId ? 'page' : undefined}>
          Offers
        </a>
        <a href="/uc/order" aria-current={showOrders ? 'page' : undefined}>
          Your orders
        </a>
        <a href="/uc/ad" aria-current={showMine ? 'page' : undefined}>
          Your offers
        </a>
        <a href="/p2p?view=methods" aria-current={showMethods ? 'page' : undefined}>
          Payment methods
        </a>
        <a href="/p2p?view=access" aria-current={showAccess ? 'page' : undefined}>
          Trading access
        </a>
      </nav>
      {current === '/chat' || tradeId ? (
        <OrderDetail pay={pay} tradeId={tradeId ?? ''} userId={userId} />
      ) : current === '/checkuser' ? (
        counterparty && id.safeParse(counterparty).success ? (
          <Counterparty pay={pay} userId={counterparty} />
        ) : (
          <PayNotice title="Choose a counterparty">Open a counterparty from an offer to see the authoritative trade reputation.</PayNotice>
        )
      ) : showOrders ? (
        <OrderList pay={pay} userId={userId} />
      ) : publish ? (
        <PublishAvailability pay={pay} />
      ) : showAccess ? (
        <TradingProgramme pay={pay} userId={userId} />
      ) : showMethods ? (
        <PaymentMethods pay={pay} userId={userId} />
      ) : (
        <OfferBoard pay={pay} userId={userId} mine={showMine} />
      )}
    </Page>
  );
}
function OfferBoard({ pay, userId, mine }: { pay: PersonalPayApi; userId: string | null; mine: boolean }) {
  const [limit, setLimit] = useState(50);
  const [asset, setAsset] = useState('');
  const [fiat, setFiat] = useState('');
  const [side, setSide] = useState('');
  const [filter, setFilter] = useState<{ asset?: string; fiatCurrency?: string; side?: 'buy' | 'sell' }>({});
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<Offer | null>(null);
  const list = useResource((signal) => pay.offers({ ...filter, limit }, signal), `pay:offers:${userId}:${JSON.stringify(filter)}:${limit}`);
  const currencies = useResource((signal) => pay.fiat(signal), 'pay:fiat');
  return (
    <div className="stack">
      <PaySection
        title={mine ? 'Your offers' : 'Offer board'}
        description={
          mine
            ? 'Your offers inside the loaded market window. The service has no maker-specific list or continuation.'
            : 'Prices and remaining quantities come from the P2P service.'
        }
        action={
          <a className="text-link" href="/uc/ad/create">
            Create offer →
          </a>
        }
      >
        <form
          className="pay-filters"
          onSubmit={(event) => {
            event.preventDefault();
            if (fiat && fiat.length !== 3) {
              setError('Fiat currency must use its three-letter code.');
              return;
            }
            setError('');
            setFilter({
              ...(asset.trim() ? { asset: asset.trim() } : {}),
              ...(fiat ? { fiatCurrency: fiat } : {}),
              ...(side ? { side: side as 'buy' | 'sell' } : {}),
            });
            setOpened(null);
          }}
        >
          <Field label="Asset" value={asset} onChange={(event) => setAsset(event.target.value.toUpperCase())} maxLength={16} />
          <label className="field">
            Fiat currency
            <select value={fiat} onChange={(event) => setFiat(event.target.value)}>
              <option value="">All returned currencies</option>
              {currencies.resource.status === 'ready' &&
                currencies.resource.data.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} · {currency.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            Maker side
            <select value={side} onChange={(event) => setSide(event.target.value)}>
              <option value="">Buy and sell</option>
              <option value="sell">Selling asset</option>
              <option value="buy">Buying asset</option>
            </select>
          </label>
          <Button type="submit" variant="secondary">
            Apply filters
          </Button>
        </form>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <PayState resource={list.resource} retry={list.reload} empty="No offers returned for these filters">
          {(rows) => {
            const visible = mine ? rows.filter((offer) => offer.makerId === userId) : rows;
            return (
              <>
                {visible.length ? (
                  <DataTable label="P2P offers" headers={['Maker / asset', 'Price', 'Asset limits', 'Status', '']}>
                    {visible.map((offer) => (
                      <tr key={offer.id}>
                        <td>
                          <strong>
                            {offer.side === 'sell' ? 'Selling' : 'Buying'} {offer.asset}
                          </strong>
                          <small className="pay-cell-note">{offer.makerId}</small>
                        </td>
                        <td className="numeric">
                          {displayAmount(offer.price)} {offer.fiatCurrency}
                          <small className="pay-cell-note">
                            {offer.priceType === 'float' ? 'Floating price parameter' : `Per ${offer.asset}`}
                          </small>
                        </td>
                        <td className="numeric">
                          {displayAmount(offer.minAmount)} – {displayAmount(offer.maxAmount)} {offer.asset}
                          <small className="pay-cell-note">{displayAmount(offer.remainingAmount)} remaining</small>
                        </td>
                        <td>
                          <Status value={offer.status} />
                        </td>
                        <td>
                          <Button variant="ghost" onClick={() => setOpened(offer)}>
                            Details
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                ) : (
                  <PayNotice title="No own offers in this window">
                    Increase the window or choose filters to find older offers. An empty subset does not prove the account has no offers.
                  </PayNotice>
                )}
                <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
              </>
            );
          }}
        </PayState>
      </PaySection>
      {opened && (
        <OfferDetail
          key={opened.id}
          pay={pay}
          offer={opened}
          userId={userId}
          onChanged={() => {
            setOpened(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}
function OfferDetail({
  pay,
  offer,
  userId,
  onChanged,
}: {
  pay: PersonalPayApi;
  offer: Offer;
  userId: string | null;
  onChanged: () => void;
}) {
  const own = offer.makerId === userId;
  const [reconciled, setReconciled] = useState<ApiResult<Offer> | null>(null);
  const methodIds = offer.methods.flatMap((method) =>
    typeof method === 'string'
      ? [method]
      : method && typeof method === 'object' && 'id' in method && typeof method.id === 'string'
        ? [method.id]
        : [],
  );
  return (
    <PaySection title={`${offer.side === 'sell' ? 'Sell' : 'Buy'} ${offer.asset}`}>
      <PayDetails
        values={[
          ['Offer', offer.id],
          ['Remaining quantity', `${displayAmount(offer.remainingAmount)} ${offer.asset}`],
          ['Agreed payment methods', methodIds.join(', ') || 'No usable methods declared'],
          ['Terms', offer.terms || 'No terms supplied'],
        ]}
      />
      {own && pay.guard.status(`${userId}:offer:${offer.id}`) && (
        <div className="stack">
          <PayNotice title="Original offer action is unresolved">
            Read this offer again to verify the intended state. A new action will remain blocked if that state is not confirmed.
          </PayNotice>
          <Button
            variant="secondary"
            onClick={() => {
              void pay.reconcileOffer(offer.id).then((result) => {
                setReconciled(result);
                if (result.ok) onChanged();
              });
            }}
          >
            Check original offer action
          </Button>
          <MutationResult result={reconciled} />
        </div>
      )}
      {own ? (
        <div className="actions">
          {offer.status !== 'closed' && (
            <>
              <ReviewedAction
                title={offer.status === 'active' ? 'Pause offer' : 'Resume offer'}
                description="The service checks that you own this offer and applies its current state."
                review={
                  <PayDetails
                    values={[
                      ['Offer', offer.id],
                      ['Current state', offer.status],
                    ]}
                  />
                }
                perform={() => pay.manageOffer(offer.id, offer.status === 'active' ? 'pause' : 'resume')}
                onConfirmed={onChanged}
                disabled={Boolean(pay.guard.status(`${userId}:offer:${offer.id}`))}
              />
              <ReviewedAction
                title="Close offer"
                description="Close this offer to new orders. Existing order escrow remains governed by each order."
                perform={() => pay.manageOffer(offer.id, 'close')}
                onConfirmed={onChanged}
                disabled={Boolean(pay.guard.status(`${userId}:offer:${offer.id}`))}
              />
            </>
          )}
        </div>
      ) : (
        <>
          <a className="text-link" href={`/checkuser?userId=${encodeURIComponent(offer.makerId)}`}>
            Review counterparty →
          </a>
          <PayNotice title="New order review is unavailable">
            An authoritative fee and reservation preview is not published. Payment instruments also lack the required encryption rail. A new
            order cannot be safely reviewed here, so no escrow take is submitted.
          </PayNotice>
        </>
      )}
    </PaySection>
  );
}
function PublishAvailability({ pay }: { pay: PersonalPayApi }) {
  const health = useResource((signal) => pay.health(signal), 'pay:p2p-health');
  const methods = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  return (
    <div className="stack">
      <PayNotice title="Offer publication is unavailable">
        The P2P service refuses live offer creation until the owner’s instrument encryption provider is connected. Existing offers can still
        be read and managed. Updating an offer has no amendment contract; create is not an update.
      </PayNotice>
      <PaySection title="Service readiness">
        <PayState resource={health.resource} retry={health.reload}>
          {(data) => (
            <PayDetails
              values={[
                ['Instrument encryption', data.instrumentKmsConfigured ? 'Configured' : 'Not connected'],
                ['Offer limits', data.offerLimitsPosture],
                [
                  'Moderation',
                  data.moderation.status === 'configured' ? 'Configured; live reachability is unprobed' : 'No moderators configured',
                ],
              ]}
            />
          )}
        </PayState>
      </PaySection>
      <PaySection title="Registered payment methods">
        <PayState resource={methods.resource} retry={methods.reload} empty="No payment methods registered">
          {(rows) => (
            <div>
              {rows.map((method) => (
                <div className="pay-destination" key={`${method.methodId}:${method.country}`}>
                  <span>
                    {method.label}
                    <small>
                      {method.methodId} · {method.country}
                    </small>
                  </span>
                  <Status value={method.enabled ? 'enabled' : 'disabled'} />
                </div>
              ))}
              <PayPagination count={rows.length} limit={200} setLimit={() => {}} />
            </div>
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
function OrderList({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const [limit, setLimit] = useState(50);
  const list = useResource((signal) => pay.trades(limit, signal), `pay:orders:${userId}:${limit}`);
  return (
    <PaySection
      title="Your orders"
      description="Terminal status and ledger settlement time stay separate."
      action={
        <Button variant="secondary" onClick={list.reload}>
          Refresh orders
        </Button>
      }
    >
      <PayState resource={list.resource} retry={list.reload} empty="No P2P orders returned">
        {(rows) => (
          <>
            <DataTable headers={['Order', 'You', 'Asset quantity', 'External payment', 'Status', '']} label="Your P2P orders">
              {rows.map((trade) => (
                <tr key={trade.id}>
                  <td>
                    {trade.id.slice(0, 8)}
                    <small className="pay-cell-note">{trade.createdAt}</small>
                  </td>
                  <td>{trade.buyerId === userId ? 'Buy' : 'Sell'}</td>
                  <td className="numeric">
                    {displayAmount(trade.amount)} {trade.asset}
                  </td>
                  <td className="numeric">
                    {displayAmount(trade.fiatAmount)} {trade.fiatCurrency}
                  </td>
                  <td>
                    <Status value={trade.status} />
                    <small className="pay-cell-note">{trade.settledAt ? 'Ledger settled' : 'Ledger settlement not confirmed'}</small>
                  </td>
                  <td>
                    <a className="text-link" href={`/chat?tradeId=${encodeURIComponent(trade.id)}`}>
                      Open →
                    </a>
                  </td>
                </tr>
              ))}
            </DataTable>
            <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
          </>
        )}
      </PayState>
    </PaySection>
  );
}
function OrderDetail({ pay, tradeId, userId }: { pay: PersonalPayApi; tradeId: string; userId: string | null }) {
  const valid = id.safeParse(tradeId).success;
  const order = useResource(
    (signal) =>
      valid
        ? pay.trade(tradeId, signal)
        : Promise.resolve({ ok: false as const, reason: 'error' as const, message: 'Open a valid P2P order from Your orders.' }),
    `pay:order:${userId}:${tradeId}`,
  );
  const [destinationRequested, setDestinationRequested] = useState(false);
  const destination = useResource(
    (signal) =>
      destinationRequested
        ? pay.destination(tradeId, signal)
        : Promise.resolve({
            ok: false as const,
            reason: 'not_supported' as const,
            message: 'Payment details are revealed only on your explicit request.',
          }),
    `pay:order-destination:${userId}:${tradeId}:${destinationRequested}`,
  );
  return (
    <PayState resource={order.resource} retry={order.reload}>
      {(trade) => (
        <div className="pay-order-grid">
          <div className="stack">
            <PaySection
              title="Order details"
              action={
                <Button variant="secondary" onClick={order.reload}>
                  Refresh status
                </Button>
              }
            >
              <PayDetails
                values={[
                  ['Order', trade.id],
                  ['You', trade.buyerId === userId ? 'Buyer' : 'Seller'],
                  ['Order status', <Status value={trade.status} />],
                  ['Asset quantity', `${displayAmount(trade.amount)} ${trade.asset}`],
                  ['External payment', `${displayAmount(trade.fiatAmount)} ${trade.fiatCurrency}`],
                  ['Price', `${displayAmount(trade.price)} ${trade.fiatCurrency} per ${trade.asset}`],
                  ['Payment method', trade.method],
                  ['Deadline', trade.deadlineAt ?? 'Not supplied'],
                  ['Ledger settlement', trade.settledAt ?? 'Not confirmed'],
                ]}
              />
              {['released', 'cancelled'].includes(trade.status) && !trade.settledAt && (
                <PayNotice title="Ledger settlement is not confirmed">
                  The order reached a terminal state, but no settlement timestamp has been returned. Refresh status before treating escrow
                  as released or refunded.
                </PayNotice>
              )}
              <OrderActions trade={trade} pay={pay} userId={userId} reload={order.reload} />
            </PaySection>
            <PaySection title="External payment destination" description="Revealing details is logged by the service.">
              {destinationRequested ? (
                <PayState resource={destination.resource} retry={destination.reload}>
                  {(data) => (
                    <PayDetails
                      values={[
                        ['Destination label', data.label],
                        ['Country / currency', `${data.country} / ${data.fiatCurrency}`],
                        ...Object.entries(data.details),
                      ]}
                    />
                  )}
                </PayState>
              ) : (
                <Button
                  variant="secondary"
                  disabled={!['escrowed', 'fiat_sent', 'disputed'].includes(trade.status)}
                  onClick={() => setDestinationRequested(true)}
                >
                  Reveal agreed payment details
                </Button>
              )}
            </PaySection>
          </div>
          <div className="stack">
            <PaySection title="Order chat">
              <PayNotice title="Message thread is not connected">
                The legacy chat transport is absent from the current edge. Messages cannot be sent or read here. Order status and recorded
                dispute evidence remain available below.
              </PayNotice>
            </PaySection>
            <OrderDispute trade={trade} pay={pay} reloadOrder={order.reload} />
          </div>
        </div>
      )}
    </PayState>
  );
}
function OrderActions({ trade, pay, userId, reload }: { trade: Trade; pay: PersonalPayApi; userId: string | null; reload: () => void }) {
  const [reason, setReason] = useState('');
  const [reconciled, setReconciled] = useState<ApiResult<Trade> | null>(null);
  const locked = Boolean(pay.guard.status(`${userId}:trade:${trade.id}`));
  return (
    <div className="stack">
      {locked && (
        <PayNotice title="Original order action is unresolved">
          Refresh order status. Do not repeat the action or infer release from a missing response. If the intended transition is still
          unclear, contact Support with this order ID.
          <Button
            variant="secondary"
            onClick={() => {
              void pay.reconcileTrade(trade.id).then((result) => {
                setReconciled(result);
                if (result.ok) reload();
              });
            }}
          >
            Check original order action
          </Button>
        </PayNotice>
      )}
      <MutationResult result={reconciled} />
      <div className="actions">
        {trade.buyerId === userId && trade.status === 'escrowed' && (
          <ReviewedAction
            title="Mark payment sent"
            description="Confirm only after sending the external payment to the agreed destination. This does not prove the seller received it."
            review={
              <PayDetails
                values={[
                  ['External payment', `${displayAmount(trade.fiatAmount)} ${trade.fiatCurrency}`],
                  ['Order', trade.id],
                ]}
              />
            }
            perform={() => pay.manageTrade(trade.id, 'markFiatSent')}
            onConfirmed={reload}
            disabled={locked}
          />
        )}
        {trade.sellerId === userId && trade.status === 'fiat_sent' && (
          <ReviewedAction
            title="Release escrow"
            variant="primary"
            description="Confirm only after the external payment has arrived in your account. This asks the ledger to release the escrowed asset to the buyer."
            review={
              <PayDetails
                values={[
                  ['Release', `${displayAmount(trade.amount)} ${trade.asset}`],
                  ['Payment to verify', `${displayAmount(trade.fiatAmount)} ${trade.fiatCurrency}`],
                ]}
              />
            }
            perform={() => pay.manageTrade(trade.id, 'confirmReceived')}
            onConfirmed={reload}
            disabled={locked}
          />
        )}
      </div>
      {['created', 'escrowed'].includes(trade.status) && (
        <>
          <Field label="Cancellation reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} />
          <ReviewedAction
            title="Cancel order"
            description="The service checks current order state. An external payment already sent must not be treated as refunded by cancelling an order."
            perform={() => pay.manageTrade(trade.id, 'cancel', reason)}
            onConfirmed={reload}
            disabled={locked}
          />
        </>
      )}
    </div>
  );
}
function OrderDispute({ trade, pay, reloadOrder }: { trade: Trade; pay: PersonalPayApi; reloadOrder: () => void }) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const dispute = useResource((signal) => pay.dispute(trade.id, signal), `pay:dispute:${trade.id}:${trade.status}`);
  return (
    <PaySection title="Dispute and evidence">
      <p className="muted">
        An unattended dispute escalates and keeps escrow held. Configured moderators are not a live availability promise.
      </p>
      {trade.status === 'disputed' ? (
        <PayState resource={dispute.resource} retry={dispute.reload}>
          {(data) => (
            <>
              <PayDetails
                values={[
                  ['Reason', data.reason],
                  ['Status', data.status],
                  ['Resolution', data.resolution ?? 'No ruling'],
                  ['Ruling notes', data.resolutionNotes ?? 'No notes'],
                  ['Deadline', data.deadlineAt],
                  ['Escalations', String(data.escalations)],
                ]}
              />
              {data.evidence.map((item) => (
                <div className="pay-evidence" key={item.seq}>
                  <small className="muted">{item.submittedAt ?? 'Time not recorded'}</small>
                  <p>{typeof item.item === 'string' ? item.item : JSON.stringify(item.item)}</p>
                </div>
              ))}
              {data.status === 'open' && (
                <>
                  <Field label="Add evidence" value={evidence} onChange={(event) => setEvidence(event.target.value)} maxLength={4000} />
                  <ReviewedAction
                    title="Append evidence"
                    description="Evidence is appended to the dispute and cannot be edited or removed."
                    review={<p>{evidence}</p>}
                    perform={() => pay.appendEvidence(trade.id, evidence.trim())}
                    disabled={!evidence.trim()}
                    onConfirmed={() => {
                      setEvidence('');
                      dispute.reload();
                    }}
                  />
                </>
              )}
            </>
          )}
        </PayState>
      ) : ['escrowed', 'fiat_sent'].includes(trade.status) ? (
        <>
          <Field label="Describe the payment issue" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} />
          <ReviewedAction
            title="Open dispute"
            description="The service records your reason, opens the dispute and keeps escrow held until a ruling. This is not a refund."
            review={<p>{reason}</p>}
            perform={() => pay.openDispute(trade.id, reason.trim())}
            disabled={!reason.trim()}
            onConfirmed={() => {
              reloadOrder();
              dispute.reload();
            }}
          />
        </>
      ) : (
        <p className="muted">No open dispute action is available for this order state.</p>
      )}
    </PaySection>
  );
}
function PaymentMethods({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const [limit, setLimit] = useState(50);
  const instruments = useResource((signal) => pay.instruments(limit, signal), `pay:instruments:${userId}:${limit}`);
  return (
    <div className="stack">
      <PayNotice title="New payment destinations are unavailable">
        The required instrument encryption provider is absent. This screen reads existing destination headers; it does not invent methods,
        collect unprotected account details or show them on the public offer board.
      </PayNotice>
      <PaySection title="Your payment destination labels">
        <PayState resource={instruments.resource} retry={instruments.reload} empty="No payment destination headers returned">
          {(rows) => (
            <>
              <DataTable label="Payment destinations" headers={['Label', 'Method', 'Currency / country', 'State', '']}>
                {rows.map((instrument) => (
                  <tr key={instrument.id}>
                    <td>{instrument.label || 'Unlabelled destination'}</td>
                    <td>{instrument.methodId}</td>
                    <td>
                      {instrument.fiatCurrency} / {instrument.country}
                    </td>
                    <td>
                      <Status value={instrument.status} />
                    </td>
                    <td>
                      {instrument.status === 'active' && (
                        <ReviewedAction
                          title="Remove destination"
                          description="This removes the destination from future trades. Existing trades keep their frozen payment snapshot."
                          perform={() => pay.removeInstrument(instrument.id)}
                          onConfirmed={instruments.reload}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
            </>
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
function Counterparty({ pay, userId }: { pay: PersonalPayApi; userId: string }) {
  const reputation = useResource((signal) => pay.reputation(userId, signal), `pay:reputation:${userId}`);
  return (
    <PaySection title="Counterparty record">
      <p className="pay-account-id">{userId}</p>
      <PayState resource={reputation.resource} retry={reputation.reload}>
        {(data) => (
          <PayDetails
            values={[
              ['Trades recorded', String(data.tradesTotal)],
              ['Completed', String(data.completed)],
              ['Cancelled', String(data.cancelled)],
              ['Disputed', String(data.disputed)],
              [
                'Programme standing',
                data.merchant === null ? 'Programme unavailable' : data.merchant ? 'Approved P2P merchant' : 'Not approved',
              ],
              ['Badges', data.badges.join(', ') || 'None returned'],
            ]}
          />
        )}
      </PayState>
    </PaySection>
  );
}
function TradingProgramme({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const [reason, setReason] = useState('');
  const standing = useResource((signal) => pay.standing(signal), `pay:p2p-standing:${userId}`);
  const access = useResource((signal) => pay.apiAccess(signal), `pay:p2p-api-access:${userId}`);
  function refresh() {
    standing.reload();
    access.reload();
  }
  return (
    <div className="stack">
      <PayNotice title="P2P trading standing">
        This programme is your personal P2P trading record. It does not create a Business account, company membership or acquiring
        permissions.
      </PayNotice>
      <PaySection
        title="Your programme status"
        action={
          <Button variant="secondary" onClick={refresh}>
            Refresh standing
          </Button>
        }
      >
        <PayState resource={standing.resource} retry={standing.reload}>
          {(data) =>
            data ? (
              <div className="form-stack">
                <PayDetails
                  values={[
                    ['Standing', data.status],
                    ['Application submitted', data.appliedAt],
                    ['Decision', data.decidedAt ?? 'Not recorded'],
                    ['Trades at application', String(data.appliedTradesTotal)],
                  ]}
                />
                {['applied', 'approved', 'suspended'].includes(data.status) && (
                  <>
                    <Field label="Reason for leaving" value={reason} onChange={(event) => setReason(event.target.value)} />
                    <ReviewedAction
                      title="Leave P2P programme"
                      description="Withdraw your personal P2P programme membership. Your existing order escrow is not released by leaving."
                      review={<p>{reason}</p>}
                      perform={() => pay.withdrawProgramme(reason.trim())}
                      onConfirmed={refresh}
                      disabled={!reason.trim()}
                    />
                  </>
                )}
                {['rejected', 'withdrawn'].includes(data.status) && (
                  <ReviewedAction
                    title="Reapply to P2P programme"
                    description="Submit a new application based on current earned reputation. The previous decision is not automatically restored."
                    perform={() => pay.applyProgramme()}
                    onConfirmed={refresh}
                  />
                )}
              </div>
            ) : (
              <div className="stack">
                <p className="muted">No P2P programme application exists for this account.</p>
                <ReviewedAction
                  title="Apply to P2P programme"
                  description="Submit an application on your own behalf. The service checks your actual trading record; an application is not an approval or an offer limit increase."
                  perform={() => pay.applyProgramme()}
                  onConfirmed={refresh}
                />
              </div>
            )
          }
        </PayState>
      </PaySection>
      <PaySection title="P2P API eligibility">
        <PayState resource={access.resource} retry={access.reload}>
          {(data) => (
            <PayDetails
              values={[
                ['API standing', data.eligible ? 'Eligible by current programme standing' : 'Not eligible by current programme standing'],
                ['Current credential', data.credential],
                ['Dispute decisions', 'Interactive human only'],
              ]}
            />
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
