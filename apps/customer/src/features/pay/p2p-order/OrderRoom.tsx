// volt-room: /uc/order
// volt-room: /chat
import type { P2pCancelReason } from '@intafaced/contracts/p2p-cancel';
import { useState, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Checkbox, RecordListTemplate } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { payCopy, PayCopy, payRefusal } from '../copy';
import { CancelOrder, RequestCancel } from '../p2p-cancel';
import { BuyerMismatch, ReportMismatch } from '../p2p-mismatch';
import { orderCopy } from '../p2p-order-copy';
import { ReleaseAction } from '../p2p-release';
import { PaymentNoteRules, ReportRemark } from '../p2p-remark';
import { RemindSeller } from '../p2p-remind';
import { P2PTabs } from '../p2p-tabs';
import { ValidatePayment } from '../p2p-validate';
import type { PersonalPayApi } from '../pay-api';
import { P2POrder } from '../P2POrder';
import { ContractEscrowPanel } from '../personal/ContractEscrow';
import { OrderChat } from '../personal/OrderChat';
import { OrderHistory } from '../personal/OrderHistory';
import { OrderReceipt } from '../personal/OrderReceipt';
import { OrderReview } from '../personal/OrderReview';
import { DisputeProgress, EscrowPath } from '../personal/P2PDepth';
import { p2pDepth } from '../personal/p2p-depth-copy';
import type { Trade, TradeDestination } from '../schemas';
import { EmptyState, Field, PayAmount, PayDetails, PayNotice, PaySection, PayState, ReviewedAction } from '../volt/parts';

/**
 * `/uc/order` (also `/p2p/orders` and `/p2p/orders/:tradeId`) and `/chat`, on the record-list template: the P2P rooms
 * above, then the person's order history, one open order in full (ledger or contract escrow, external payment details,
 * receipt, review, chat and dispute), or the "Choose an order" prompt when `/chat` opens with no order id.
 */
export function OrderRoom({
  pay,
  tradeId,
  userId,
  chat = false,
}: {
  pay: PersonalPayApi;
  tradeId: string | null;
  userId: string | null;
  chat?: boolean;
}) {
  const { layoutMode } = usePreferences();
  const mode = layoutMode === 'pro' ? 'pro' : 'simple';
  if (tradeId || chat) {
    return (
      <RecordListTemplate
        title={payCopy.t('p2pOrder')}
        section={<P2PTabs order current="/uc/order" />}
        state={{ kind: 'ready' }}
        mode={mode}
        list={
          tradeId ? (
            <OrderDetail pay={pay} tradeId={tradeId} userId={userId} />
          ) : (
            <EmptyState
              title={p2pDepth.t('chatPickTitle')}
              action={
                <a className="lt-button lt-button-primary" href="/uc/order">
                  {p2pDepth.t('chatPickAction')}
                </a>
              }
            >
              {p2pDepth.t('chatPickBody')}
            </EmptyState>
          )
        }
      />
    );
  }
  return (
    <RecordListTemplate
      title={payCopy.t('personToPerson')}
      description={payCopy.t('externalPaymentLedgerEscrowAndARecorded')}
      section={<P2PTabs current="/uc/order" />}
      state={{ kind: 'ready' }}
      mode={mode}
      list={<OrderHistory pay={pay} userId={userId} />}
    />
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
                <p className="lt-muted" data-testid="order-payee-name-rule">
                  {order.t('payeeNameRule')}
                </p>
              ) : null}
            </>
          )}
        </PayState>
      ) : (
        <Button
          tone="secondary"
          disabled={!['escrowed', 'fiat_sent', 'disputed'].includes(trade.status)}
          onClick={() => setRequested(true)}
        >
          <PayCopy k="revealAgreedPaymentDetails" />
        </Button>
      )}
    </PaySection>
  );
}

type PaidChecks = { amount: boolean; ownAccount: boolean; details: boolean };
const EMPTY_PAID_CHECKS: PaidChecks = { amount: false, ownAccount: false, details: false };

/**
 * The buyer's three ticks before Mark payment sent. Reset each time the review opens, so closing it to go and pay, then
 * coming back, asks again.
 */
function PaidChecklist({
  trade,
  checks,
  onChange,
}: {
  trade: Trade;
  checks: PaidChecks;
  onChange: (update: (current: PaidChecks) => PaidChecks) => void;
}) {
  const { t } = orderCopy.useCopy();
  return (
    <fieldset className="lt-stack lt-stack-tight" data-testid="order-paid-checklist">
      <legend>{t('paidChecklist')}</legend>
      {(
        [
          ['amount', t('paidCheckAmount', { amount: displayAmount(trade.fiatAmount), currency: trade.fiatCurrency })],
          ['ownAccount', t('paidCheckOwnAccount')],
          ['details', t('paidCheckDetails')],
        ] as const
      ).map(([key, label]) => (
        <Checkbox
          key={key}
          label={label}
          checked={checks[key]}
          onChange={(event) => {
            // Read it now: React puts a controlled box back before a functional update runs.
            const checked = event.target.checked;
            onChange((current) => ({ ...current, [key]: checked }));
          }}
        />
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
  const [paidChecks, setPaidChecks] = useState<PaidChecks>(EMPTY_PAID_CHECKS);
  const paidReady = paidChecks.amount && paidChecks.ownAccount && paidChecks.details;
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
    <div className="lt-stack">
      <div className="lt-actions">
        {trade.buyerId === userId && trade.status === 'escrowed' && (
          <ReviewedAction
            title={payCopy.t('markPaymentSent')}
            description={payCopy.t('confirmOnlyAfterSendingTheExternalPayment')}
            onOpen={() => setPaidChecks(EMPTY_PAID_CHECKS)}
            review={
              <div className="lt-stack">
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
                <PaidChecklist trade={trade} checks={paidChecks} onChange={setPaidChecks} />
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
        <details className="lt-stack">
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
      <p className="lt-muted">
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
                <div className="lt-stack lt-stack-tight" key={item.seq}>
                  <small className="lt-muted">{item.submittedAt ?? payCopy.t('timeNotRecorded')}</small>
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
        <p className="lt-muted">
          <PayCopy k="noOpenDisputeActionIsAvailableFor" />
        </p>
      )}
    </PaySection>
  );
}
