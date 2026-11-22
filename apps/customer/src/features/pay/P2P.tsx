import type { P2pCancelReason } from '@intafaced/contracts/p2p-cancel';
import { ContractEscrowPanel } from './personal/ContractEscrow';
import { payCopy, PayCopy, payRefusal } from './copy';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui';
import { EmptyState, Field, Page } from './ui-kit';
import { createPersonalPayApi, type PersonalPayApi } from './pay-api';
import { PayAmount, PayDetails, PayNotice, PaySection, PayState, ReviewedAction } from './components';
import { id, type Trade, type TradeDestination } from './schemas';
import { CancelOrder, RequestCancel } from './p2p-cancel';
import { displayAmount } from '../../shared/money';
import { useP2PView, type P2PView } from './p2p-view';
import { P2POffers } from './P2POffers';
import { P2POrder } from './P2POrder';
import { ReleaseAction } from './p2p-release';
import { RemindSeller } from './p2p-remind';
import { BuyerMismatch, ReportMismatch } from './p2p-mismatch';
import { PaymentNoteRules, ReportRemark } from './p2p-remark';
import { ValidatePayment } from './p2p-validate';
import { orderCopy } from './p2p-order-copy';
import { P2PCounterparty } from './P2PCounterparty';
import { p2pReturn } from './p2p-return';
import { DisputeProgress, EscrowPath } from './personal/P2PDepth';
import { OrderChat } from './personal/OrderChat';
import { OrderHistory } from './personal/OrderHistory';
import { OrderReceipt } from './personal/OrderReceipt';
import { OrderReview } from './personal/OrderReview';
import { p2pDepth } from './personal/p2p-depth-copy';
import { P2PEligibilityPanel } from './personal/Eligibility';
import { PaymentMethods } from './personal/PaymentMethods';
import { P2PFlowRoom, type P2PFlowRoomId } from './p2p-flow/P2PFlowRoom';

export function P2P({ path }: { path: string }) {
  const view = useP2PView();
  return <P2PCurrent key={view.epoch} path={path} view={view} />;
}
function P2PCurrent({ path, view }: { path: string; view: P2PView }) {
  const { api, userId } = view;
  const pay = useMemo(() => createPersonalPayApi(api, userId, undefined, view.current), [view]);
  const params = new URLSearchParams(
    path.includes('?') ? path.slice(path.indexOf('?')) : typeof location === 'undefined' ? '' : location.search,
  );
  const current = path.split('?')[0] ?? '/p2p';
  const tradeId =
    current === '/checkuser'
      ? undefined
      : (params.get('tradeId') ?? (current === '/chat' ? params.get('id') : null) ?? path.match(/^\/p2p\/orders\/([^/?]+)/)?.[1]);
  const showOrders = current === '/uc/order' || current === '/p2p/orders';
  const showMine = current === '/uc/ad' || current === '/p2p/offers';
  const showMethods = current === '/p2p/methods' || params.get('view') === 'methods';
  const showAccess = current === '/p2p/access' || params.get('view') === 'access';
  const publish = current === '/uc/ad/create' || current === '/uc/ad/update' || current === '/p2p/offers/new';
  const counterparty = params.get('userId') ?? params.get('userid') ?? (current === '/checkuser' ? params.get('id') : null);
  const inspectionReturn = p2pReturn(params.get('returnTo'));
  const inspectionMine = current === '/checkuser' && inspectionReturn.href.split(/[?#]/)[0] === '/uc/ad';
  // My offers, Create and Edit offer and Trading access are flow rooms of their own (`p2p-flow/`), in the same order of
  // precedence as below: an order or a counterparty first, then the form, access, payment methods, your offers.
  const flow: P2PFlowRoomId | null =
    current === '/chat' || tradeId || current === '/checkuser' || showOrders
      ? null
      : publish
        ? 'offer'
        : showAccess
          ? 'access'
          : showMethods
            ? null
            : showMine
              ? 'mine'
              : null;
  if (flow) return <P2PFlowRoom room={flow} pay={pay} userId={userId} current={current} params={params} />;
  return (
    <Page
      eyebrow={payCopy.t('personalPay')}
      title={
        current === '/chat' || tradeId
          ? payCopy.t('p2pOrder')
          : current === '/checkuser'
            ? payCopy.t('counterparty')
            : publish
              ? current === '/uc/ad/update'
                ? p2pDepth.t('formEditTitle')
                : payCopy.t('createAnOffer')
              : payCopy.t('personToPerson')
      }
      description={
        tradeId || current === '/chat' || (!showOrders && !showMethods && !showAccess && !publish)
          ? undefined
          : payCopy.t('externalPaymentLedgerEscrowAndARecorded')
      }
    >
      <nav
        className={`pay-room-tabs${tradeId || current === '/chat' ? ' pay-order-tabs' : ''}`}
        aria-label={payCopy.t('p2pRooms')}
        onFocus={(event) => {
          if (event.target instanceof HTMLAnchorElement) event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}
      >
        <a
          href="/p2p"
          aria-current={
            !showOrders &&
            !showMine &&
            !showMethods &&
            !showAccess &&
            !publish &&
            !tradeId &&
            current !== '/chat' &&
            !inspectionMine &&
            (current !== '/checkuser' || inspectionReturn.kind === 'offer' || inspectionReturn.kind === 'offers')
              ? 'page'
              : undefined
          }
        >
          <PayCopy k="offers" />
        </a>
        <a
          href="/uc/order"
          aria-current={
            showOrders ||
            tradeId ||
            current === '/chat' ||
            (current === '/checkuser' && ['order', 'orders'].includes(inspectionReturn.kind))
              ? 'page'
              : undefined
          }
        >
          <PayCopy k="yourOrders" />
        </a>
        <a href="/uc/ad" aria-current={showMine || inspectionMine ? 'page' : undefined}>
          <PayCopy k="yourOffers" />
        </a>
        <a href="/p2p/methods" aria-current={showMethods ? 'page' : undefined}>
          <PayCopy k="paymentMethods" />
        </a>
        <a href="/p2p/access" aria-current={showAccess ? 'page' : undefined}>
          <PayCopy k="tradingAccess" />
        </a>
      </nav>
      {current === '/chat' && !tradeId ? (
        <EmptyState
          title={p2pDepth.t('chatPickTitle')}
          action={
            <a className="button button--primary" href="/uc/order">
              {p2pDepth.t('chatPickAction')}
            </a>
          }
        >
          {p2pDepth.t('chatPickBody')}
        </EmptyState>
      ) : current === '/chat' || tradeId ? (
        <OrderDetail pay={pay} tradeId={tradeId ?? ''} userId={userId} />
      ) : current === '/checkuser' ? (
        counterparty && id.safeParse(counterparty).success ? (
          <P2PCounterparty pay={pay} userId={counterparty} returnTo={params.get('returnTo')} />
        ) : (
          <EmptyState
            title={p2pDepth.t('cpPickTitle')}
            action={
              <div className="actions">
                <a className="button button--primary" href="/p2p">
                  {p2pDepth.t('cpPickOffers')}
                </a>
                <a className="button button--secondary" href="/uc/order">
                  {p2pDepth.t('cpPickOrders')}
                </a>
              </div>
            }
          >
            {p2pDepth.t('cpPickBody')}
          </EmptyState>
        )
      ) : showOrders ? (
        <OrderHistory pay={pay} userId={userId} />
      ) : showMethods ? (
        <PaymentMethods pay={pay} userId={userId} />
      ) : (
        <div className="stack">
          {/* An open ad has the same checks beside its take form; the hub lists them all. */}
          {params.get('offerId') ? null : <P2PEligibilityPanel pay={pay} userId={userId} />}
          <P2POffers pay={pay} userId={userId} mine={false} />
        </div>
      )}
    </Page>
  );
}
function OrderDetail({ pay, tradeId, userId }: { pay: PersonalPayApi; tradeId: string; userId: string | null }) {
  return (
    <P2POrder
      pay={pay}
      tradeId={tradeId}
      userId={userId}
      renderActions={(trade, reload, locked, outcome) => (
        <OrderActions trade={trade} pay={pay} userId={userId} reload={reload} locked={locked} onOutcome={outcome} />
      )}
      renderSecondary={(trade, reload) => (
        <>
          <EscrowPath trade={trade} userId={userId} />
          <OrderReceipt pay={pay} trade={trade} />
          <OrderReview key={'review:' + trade.id + ':' + trade.status} pay={pay} trade={trade} />
          <OrderPaymentDetails key={trade.id + ':' + trade.status} trade={trade} pay={pay} userId={userId} />
          <PaymentNoteRules trade={trade} pay={pay} userId={userId} />
          <ReportRemark key={trade.id} trade={trade} pay={pay} userId={userId} />
          <OrderChat pay={pay} trade={trade} userId={userId} />
          {trade.escrowKind !== 'contract' ? <OrderDispute trade={trade} pay={pay} reloadOrder={reload} /> : null}
        </>
      )}
    />
  );
}
/** The agreed destination's values under the server's labels, in the server's order; any other key under its own name. */
export function destinationRows(data: Pick<TradeDestination, 'details' | 'fields'>): [string, string][] {
  const named = data.fields.filter((field) => Object.hasOwn(data.details, field.key));
  const known = new Set(named.map((field) => field.key));
  const rest = Object.keys(data.details).filter((key) => !known.has(key));
  return [
    ...named.map((field): [string, string] => [field.label, data.details[field.key]!]),
    ...rest.map((key): [string, string] => [key, data.details[key]!]),
  ];
}
export function OrderPaymentDetails({ trade, pay, userId }: { trade: Trade; pay: PersonalPayApi; userId: string | null }) {
  const order = orderCopy.useCopy();
  // The payee rule and the change notice are for whoever is not the seller; the seller sees their own details plainly.
  const isBuyer = userId !== null && userId !== trade.sellerId;
  const [requested, setRequested] = useState(false);
  const destination = useResource(
    (signal) =>
      requested
        ? pay.destination(trade.id, signal, { method: trade.method, fiatCurrency: trade.fiatCurrency })
        : Promise.resolve(payRefusal('paymentDetailsAreRevealedOnlyOnYour', { reason: 'not_supported' })),
    `pay:order-destination:${userId}:${trade.id}:${requested}`,
  );
  return (
    <PaySection title={payCopy.t('externalPaymentDestination')} description={payCopy.t('revealingDetailsIsLoggedByTheService')}>
      {requested ? (
        <PayState resource={destination.resource} retry={destination.reload}>
          {(data) => (
            <>
              {isBuyer && data.payeeChange ? (
                <div data-testid="order-payee-changed">
                  <PayNotice title={order.t(data.payeeChange.kind === 'removed' ? 'payeeRemovedTitle' : 'payeeChangedTitle')}>
                    {order.t(trade.status === 'escrowed' ? 'payeeChangedBody' : 'payeeChangedAfterPaidBody')}
                  </PayNotice>
                </div>
              ) : null}
              <PayDetails
                values={[
                  [payCopy.t('destinationLabel'), <span lang="und">{data.label}</span>],
                  [payCopy.t('countryCurrency'), `${data.country} / ${data.fiatCurrency}`],
                  ...destinationRows(data).map(([label, value]): [string, ReactNode, string?] => [
                    label,
                    <span lang="und">{value}</span>,
                    'und',
                  ]),
                ]}
              />
              {isBuyer ? (
                <p className="muted" data-testid="order-payee-name-rule">
                  {order.t('payeeNameRule')}
                </p>
              ) : null}
            </>
          )}
        </PayState>
      ) : (
        <Button
          variant="secondary"
          disabled={!['escrowed', 'fiat_sent', 'disputed'].includes(trade.status)}
          onClick={() => setRequested(true)}
        >
          <PayCopy k="revealAgreedPaymentDetails" />
        </Button>
      )}
    </PaySection>
  );
}
/**
 * The buyer's three ticks before Mark payment sent. It lives inside the review, so every time the review opens the
 * boxes start empty: closing it to go and pay, then coming back, asks again.
 */
function PaidChecklist({ trade, onReady }: { trade: Trade; onReady: (ready: boolean) => void }) {
  const { t } = orderCopy.useCopy();
  const [checks, setChecks] = useState({ amount: false, ownAccount: false, details: false });
  const ready = checks.amount && checks.ownAccount && checks.details;
  useEffect(() => onReady(ready), [ready]);
  useEffect(() => () => onReady(false), []);
  return (
    <fieldset className="p2p-paid-checklist" data-testid="order-paid-checklist">
      <legend>{t('paidChecklist')}</legend>
      {(
        [
          ['amount', t('paidCheckAmount', { amount: displayAmount(trade.fiatAmount), currency: trade.fiatCurrency })],
          ['ownAccount', t('paidCheckOwnAccount')],
          ['details', t('paidCheckDetails')],
        ] as const
      ).map(([key, label]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={checks[key]}
            onChange={(event) => {
              // Read it now: React puts a controlled box back before a functional update runs.
              const checked = event.target.checked;
              setChecks((current) => ({ ...current, [key]: checked }));
            }}
          />
          <span>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}
export function OrderActions({
  trade,
  pay,
  userId,
  reload,
  locked,
  onOutcome,
}: {
  trade: Trade;
  pay: PersonalPayApi;
  userId: string | null;
  reload: () => void;
  locked: boolean;
  onOutcome: (result: ApiResult<Trade>) => void;
}) {
  // J-p2p-01 #7: the buyer confirms three facts about the outside payment before the order says it was paid.
  const [paidReady, setPaidReady] = useState(false);
  const { Copy, t } = orderCopy.useCopy();
  if (locked) return null;
  const reviewValues: [string, ReactNode][] = [
    [payCopy.t('order'), <span lang="zxx">{trade.id}</span>],
    [payCopy.t('you'), trade.sellerId === userId ? payCopy.t('seller') : payCopy.t('buyer')],
  ];
  const perform = async (
    action: 'markFiatSent' | 'confirmReceived' | 'cancel',
    current: () => boolean,
    stepUpApprovalId?: string,
    cancelReason?: P2pCancelReason,
  ) => {
    const reason = action === 'cancel' && cancelReason ? { code: cancelReason } : undefined;
    const result = await pay.manageTrade(trade.id, action, reason, { expected: trade, current }, stepUpApprovalId);
    onOutcome(result);
    return result;
  };
  return (
    <div className="stack">
      <div className="actions">
        {trade.buyerId === userId && trade.status === 'escrowed' && (
          <ReviewedAction
            title={payCopy.t('markPaymentSent')}
            description={payCopy.t('confirmOnlyAfterSendingTheExternalPayment')}
            review={
              <div className="p2p-order-review">
                <PayDetails
                  values={[
                    ...reviewValues,
                    [
                      payCopy.t('externalPayment'),
                      <PayAmount value={trade.fiatAmount} unit={trade.fiatCurrency} label={payCopy.t('externalPayment')} />,
                    ],
                    [payCopy.t('paymentMethod'), <span lang="zxx">{trade.method}</span>],
                  ]}
                />
                <PaidChecklist trade={trade} onReady={setPaidReady} />
              </div>
            }
            ready={paidReady}
            notReadyReason={t('paidChecklistIncomplete')}
            perform={(current) => perform('markFiatSent', current)}
            onConfirmed={reload}
            disabled={locked}
          />
        )}
        {trade.buyerId === userId && trade.status === 'fiat_sent' && <RemindSeller trade={trade} pay={pay} onSent={reload} />}
        {trade.buyerId === userId && trade.status === 'fiat_sent' && <BuyerMismatch trade={trade} />}
        {/* RC-p2p-02: a contract order is released, refunded and disputed on the contract (ContractEscrowPanel). */}
        {trade.escrowKind === 'contract' && <ContractEscrowPanel pay={pay} trade={trade} userId={userId} reload={reload} />}
        {trade.escrowKind !== 'contract' && trade.sellerId === userId && trade.status === 'fiat_sent' && (
          <ReleaseAction
            trade={trade}
            pay={pay}
            release={(current, stepUpApprovalId) => perform('confirmReceived', current, stepUpApprovalId)}
            onConfirmed={reload}
            disabled={locked}
          />
        )}
        {trade.sellerId === userId && trade.status === 'fiat_sent' && <ValidatePayment trade={trade} pay={pay} onChecked={reload} />}
        {trade.sellerId === userId && trade.status === 'fiat_sent' && <ReportMismatch trade={trade} pay={pay} onReported={reload} />}
        {trade.escrowKind !== 'contract' && trade.sellerId === userId && trade.status === 'fiat_sent' && <RequestCancel />}
      </div>
      {trade.escrowKind !== 'contract' && ['created', 'escrowed'].includes(trade.status) && (
        <details className="p2p-order-other">
          <summary>
            <Copy k="other" />
          </summary>
          <CancelOrder
            trade={trade}
            seller={trade.sellerId === userId}
            reviewValues={reviewValues}
            perform={(code, current) => perform('cancel', current, undefined, code)}
            onConfirmed={reload}
            disabled={locked}
          />
        </details>
      )}
    </div>
  );
}
function OrderDispute({ trade, pay, reloadOrder }: { trade: Trade; pay: PersonalPayApi; reloadOrder: () => void }) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const dispute = useResource((signal) => pay.dispute(trade.id, signal), `pay:dispute:${trade.id}:${trade.status}`);
  return (
    <PaySection title={payCopy.t('disputeAndEvidence')}>
      <p className="muted">
        <PayCopy k="anUnattendedDisputeEscalatesAndKeepsEscrow" />
      </p>
      {trade.status === 'disputed' ? (
        <PayState resource={dispute.resource} retry={dispute.reload}>
          {(data) => (
            <>
              <DisputeProgress dispute={data} />
              <PayDetails
                values={[
                  [payCopy.t('reason'), data.reason],
                  [payCopy.t('status'), data.status],
                  [payCopy.t('resolution'), data.resolution ?? payCopy.t('noRuling')],
                  [payCopy.t('rulingNotes'), data.resolutionNotes ?? payCopy.t('noNotes')],
                  [payCopy.t('deadline'), data.deadlineAt],
                  [payCopy.t('escalations'), String(data.escalations)],
                ]}
              />
              {data.evidence.map((item) => (
                <div className="pay-evidence" key={item.seq}>
                  <small className="muted">{item.submittedAt ?? payCopy.t('timeNotRecorded')}</small>
                  <p>{typeof item.item === 'string' ? item.item : JSON.stringify(item.item)}</p>
                </div>
              ))}
              {data.status === 'open' && (
                <>
                  <Field
                    label={payCopy.t('addEvidence')}
                    value={evidence}
                    onChange={(event) => setEvidence(event.target.value)}
                    maxLength={4000}
                  />
                  <ReviewedAction
                    title={payCopy.t('appendEvidence')}
                    description={payCopy.t('evidenceIsAppendedToTheDisputeAnd')}
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
          <Field
            label={payCopy.t('describeThePaymentIssue')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
          />
          <ReviewedAction
            title={payCopy.t('openDispute')}
            description={payCopy.t('theServiceRecordsYourReasonOpensThe')}
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
        <p className="muted">
          <PayCopy k="noOpenDisputeActionIsAvailableFor" />
        </p>
      )}
    </PaySection>
  );
}
