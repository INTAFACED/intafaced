import { CounterpartyLink, p2pReturn } from './p2p-return';
import { SellerReminder } from './p2p-remind';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui';
import { displayAmount } from '../../shared/money';
import { type PersonalPayApi } from './pay-api';
import { id, type Trade } from './schemas';
import { payCopy, PayCopy, payRefusal } from './copy';
import { orderCopy } from './p2p-order-copy';
import { PayAmount, PayDetails, PayFailure, PayState, PayTime } from './components';
import { TradeStatus } from './personal/P2PDepth';
import { OrderSettlement } from './personal/Settlement';
import { percentOf } from './portal/payments/payment-model';
import { ContactActions } from './personal/ContactActions';
import { CounterpartyName } from './P2PCounterparty';
import './p2p-order.css';

/** The other side of the order by their handle (J-p2p-02 #2), never their account id. */
function OrderCounterparty({ pay, userId }: { pay: PersonalPayApi; userId: string }) {
  const reputation = useResource((signal) => pay.reputation(userId, signal), `pay:reputation:${userId}`);
  return <CounterpartyName resource={reputation.resource} />;
}

/**
 * What a released order came to, from the order record alone. "Released" is the recorded decision; the ledger pays out
 * after it, so nothing is called received until the record carries the settlement time. The order read carries the fee
 * frozen at take and, once released, the buyer's share after it; a record without them says the fee is not on it.
 */
export function OrderResult({ trade, seller }: { trade: Trade; seller: boolean }) {
  const { t } = orderCopy.useCopy();
  const fiat = `${displayAmount(trade.fiatAmount)} ${trade.fiatCurrency}`;
  const quantity = { amount: displayAmount(trade.amount), asset: trade.asset };
  return (
    <section className="p2p-order-result" aria-label={t('resultTitle')} data-testid="order-result">
      <h3>{t('resultTitle')}</h3>
      {trade.settledAt === null ? (
        <p className="muted" data-testid="order-result-unsettled">
          {t('releasePending')}
        </p>
      ) : (
        <PayDetails
          values={
            seller
              ? [
                  [t('youSent'), t('sentValue', quantity)],
                  [t('youReceivedExternal'), fiat],
                  // J-p2p-02 #6: the fee this release took, at the rate frozen at take, off the released amount.
                  ...(trade.fee && trade.feeBps !== undefined
                    ? ([
                        [
                          t('serviceFee'),
                          t('serviceFeeRateValue', { amount: displayAmount(trade.fee), asset: trade.asset, rate: percentOf(trade.feeBps) }),
                        ],
                      ] satisfies [string, string][])
                    : []),
                ]
              : trade.netAmount && trade.fee && trade.feeBps !== undefined
                ? [
                    [t('youReceived'), t('receivedNetValue', { amount: displayAmount(trade.netAmount), asset: trade.asset })],
                    [t('youPaidExternal'), fiat],
                    [
                      t('serviceFee'),
                      t('serviceFeeRateValue', { amount: displayAmount(trade.fee), asset: trade.asset, rate: percentOf(trade.feeBps) }),
                    ],
                  ]
                : [
                    [t('youReceived'), t('receivedValue', quantity)],
                    [t('youPaidExternal'), fiat],
                    [t('serviceFee'), t('serviceFeeValue')],
                  ]
          }
        />
      )}
    </section>
  );
}
type Outcome = ApiResult<Trade>;
export function P2POrder({
  pay,
  tradeId,
  userId,
  renderActions,
  renderSecondary,
}: {
  pay: PersonalPayApi;
  tradeId: string;
  userId: string | null;
  renderActions: (trade: Trade, reload: () => void, locked: boolean, outcome: (result: Outcome) => void) => ReactNode;
  renderSecondary: (trade: Trade, reload: () => void) => ReactNode;
}) {
  const { Copy, t, languageFor, directionFor } = orderCopy.useCopy();
  const valid = id.safeParse(tradeId).success;
  const reference = valid ? tradeId.toLowerCase() : tradeId;
  const key = `${userId}:trade:${reference}`;
  const query = useResource(
    (signal) => (valid ? pay.trade(reference, signal) : Promise.resolve(payRefusal('openAValidP2pOrderFromYour', { reason: 'error' }))),
    `pay:order:${userId}:${reference}`,
  );
  const [, notify] = useState(0);
  const [actionResult, setActionResult] = useState<Outcome | null>(null);
  const [recovery, setRecovery] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [arrival, setArrival] = useState(0);
  const mounted = useRef(true),
    heading = useRef<HTMLHeadingElement>(null),
    attempt = useRef<object | null>(null);
  const locked = Boolean(pay.guard.status(key));
  useLayoutEffect(() => {
    mounted.current = true;
    void pay.guard.restore(key).then(() => {
      if (mounted.current) notify((value) => value + 1);
    });
    return () => {
      mounted.current = false;
      attempt.current = null;
    };
  }, [pay, key]);
  useLayoutEffect(() => {
    if (!arrival || !locked || document.querySelector('[role="dialog"]')) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }, [arrival]);
  const outcome = (result: Outcome) => {
    if (!mounted.current || (!result.ok && result.reason === 'aborted')) return;
    setActionResult(result);
    notify((value) => value + 1);
    if (pay.guard.status(key)) setArrival((value) => value + 1);
    // A readback can retire stale facts, but cannot settle the original.
    query.reload();
  };
  async function checkOriginal() {
    if (attempt.current || !mounted.current) return;
    const current = {};
    attempt.current = current;
    setBusy(true);
    const known = pay.guard.knownProof(key);
    if (known) {
      const cleared = await pay.guard.cleanupKnown(key, () => mounted.current, known);
      if (!mounted.current || attempt.current !== current) return;
      attempt.current = null;
      setBusy(false);
      if (!cleared) {
        setRecovery(
          payRefusal('deviceRecoveryStorageIsUnavailableEnableSession', {
            code: 'pay.recovery_journal_unavailable',
            reason: 'not_supported',
          }),
        );
        return;
      }
      notify((value) => value + 1);
      if (actionResult?.ok) setRecovery(actionResult);
      query.reload();
      return;
    }
    const result = await pay.reconcileTrade(reference);
    if (!mounted.current || attempt.current !== current) return;
    attempt.current = null;
    setBusy(false);
    setRecovery(result);
    notify((value) => value + 1);
    if (result.ok) query.reload();
  }
  return (
    <div className="p2p-order" lang={languageFor('seller')} dir={directionFor('seller')}>
      {locked && (
        <section className="p2p-original" aria-labelledby="p2p-original-heading">
          <h2 id="p2p-original-heading" ref={heading} tabIndex={-1}>
            <Copy k="original" />
          </h2>
          <p className="p2p-order-reference" lang="zxx" dir="ltr">
            {reference}
          </p>
          <p className="muted">
            <Copy k="originalBody" />
          </p>
          <Button variant="primary" disabled={busy} onClick={() => void checkOriginal()}>
            <PayCopy k={busy ? 'waitingForConfirmation' : 'checkOriginalOrderAction'} />
          </Button>
          {actionResult && !actionResult.ok && (
            <details className="p2p-outcome-details">
              <summary>
                <PayCopy k="orderStatus" />
              </summary>
              <PayFailure result={actionResult} />
            </details>
          )}
        </section>
      )}
      {recovery &&
        (recovery.ok ? (
          <section className="p2p-original-result" role="status">
            <h2>
              <Copy k="checked" />
            </h2>
            <PayDetails
              values={[
                [payCopy.t('order'), <span lang="zxx">{recovery.data.id}</span>],
                [t('reported'), <TradeStatus status={recovery.data.status} display={recovery.data.displayStatus} />],
                [
                  payCopy.t('ledgerSettlement'),
                  recovery.data.settledAt ? <PayTime value={recovery.data.settledAt} /> : payCopy.t('notConfirmed'),
                ],
              ]}
            />
          </section>
        ) : (
          <PayFailure result={recovery} />
        ))}
      {!locked && actionResult && !actionResult.ok && <PayFailure result={actionResult} />}
      <PayState resource={query.resource} retry={query.reload}>
        {(trade) => {
          const seller = trade.sellerId === userId;
          const held = ['escrowed', 'fiat_sent', 'disputed'].includes(trade.status);
          return (
            <div className="p2p-order-columns">
              <div className="p2p-order-core">
                <header data-testid="p2p-order-identity" className="p2p-order-identity">
                  <div className="p2p-order-role">
                    <strong>
                      <Copy k={seller ? 'seller' : 'buyer'} />
                    </strong>
                    <Button variant="ghost" onClick={query.reload}>
                      <PayCopy k="refreshStatus" />
                    </Button>
                  </div>
                  <p className="p2p-order-reference" lang="zxx" dir="ltr">
                    {trade.id}
                  </p>
                  <p className="muted">
                    <Copy k="reported" /> · <TradeStatus status={trade.status} display={trade.displayStatus} />
                  </p>
                </header>
                <div data-testid="p2p-order-quantities" className="p2p-order-quantities">
                  <div>
                    <p className="muted">
                      <Copy k={held ? 'escrow' : 'quantity'} />
                    </p>
                    <PayAmount value={trade.amount} unit={trade.asset} label={t(held ? 'escrow' : 'quantity')} />
                  </div>
                  <div>
                    <p className="muted">
                      <Copy k="payment" />
                    </p>
                    <PayAmount value={trade.fiatAmount} unit={trade.fiatCurrency} label={t('payment')} />
                    <p className="muted" lang="zxx">
                      {trade.method}
                    </p>
                    <OrderSettlement trade={trade} />
                  </div>
                </div>
                {trade.status === 'released' ? <OrderResult trade={trade} seller={seller} /> : null}
                {seller && trade.status === 'fiat_sent' ? <SellerReminder reminders={trade.reminders} /> : null}
                {!held && typeof trade.escrowHeld === 'string' ? (
                  <p className="muted" data-testid="order-escrow-held">
                    <Copy k="escrowHeld" /> <PayAmount value={trade.escrowHeld} unit={trade.asset} label={t('escrowHeld')} />
                  </p>
                ) : null}
                <p className="muted p2p-order-instruction">
                  <Copy
                    k={
                      seller && trade.status === 'fiat_sent'
                        ? 'verify'
                        : !seller && trade.status === 'escrowed'
                          ? 'buyerInstruction'
                          : trade.status === 'created'
                            ? 'created'
                            : trade.status === 'escrowed'
                              ? 'sellerWaiting'
                              : trade.status === 'fiat_sent'
                                ? 'buyerWaiting'
                                : trade.status === 'disputed'
                                  ? 'disputed'
                                  : 'terminal'
                    }
                  />
                </p>
                {renderActions(trade, query.reload, locked, outcome)}
              </div>
              <div className="p2p-order-secondary">
                <details className="p2p-order-facts">
                  <summary>
                    <Copy k="details" />
                  </summary>
                  <PayDetails
                    values={[
                      [
                        payCopy.t('price'),
                        payCopy.t('per2', { value1: displayAmount(trade.price), fiatCurrency: trade.fiatCurrency, asset: trade.asset }),
                      ],
                      [payCopy.t('deadline'), trade.deadlineAt ? <PayTime value={trade.deadlineAt} /> : payCopy.t('notSupplied')],
                      [payCopy.t('ledgerSettlement'), trade.settledAt ? <PayTime value={trade.settledAt} /> : payCopy.t('notConfirmed')],
                      [t('counterparty'), <OrderCounterparty pay={pay} userId={seller ? trade.buyerId : trade.sellerId} />],
                      [
                        t('terms'),
                        trade.terms?.trim() ? (
                          <span className="p2p-order-terms" data-testid="order-terms" lang="und">
                            {trade.terms}
                          </span>
                        ) : typeof trade.terms === 'string' ? (
                          payCopy.t('noTermsSupplied')
                        ) : (
                          t('termsUnrecorded')
                        ),
                      ],
                    ]}
                  />
                  <CounterpartyLink
                    userId={seller ? trade.buyerId : trade.sellerId}
                    returnTo={p2pReturn(location.pathname + location.search + location.hash)}
                  >
                    <Copy k="reputation" />
                  </CounterpartyLink>
                  <ContactActions pay={pay} peerId={seller ? trade.buyerId : trade.sellerId} />
                </details>
                {renderSecondary(trade, query.reload)}
              </div>
            </div>
          );
        }}
      </PayState>
    </div>
  );
}
