import { useState, type ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import type { ApiResult } from '../../shared/api';
import { PayAmount, PayDetails, PayTime, ReviewedAction } from './components';
import { payCopy } from './copy';
import { cancelCopy } from './p2p-cancel-copy';
import { orderCopy } from './p2p-order-copy';
import { P2P_BUYER_CANCEL_REASONS, P2P_SELLER_CANCEL_REASONS, type P2pCancelReason } from '@intafaced/contracts/p2p-cancel';
import type { Trade } from './schemas';

/**
 * P-trade-orders-19 (1) / J-p2p-06 #1: before payment either side may cancel, choosing a reason from its own list. The
 * buyer is warned not to cancel an order already paid. svc-p2p refunds the escrow to the seller in full, once.
 */
export function CancelOrder({
  trade,
  seller,
  reviewValues,
  perform,
  onConfirmed,
  disabled,
}: {
  trade: Trade;
  seller: boolean;
  reviewValues: [string, ReactNode][];
  perform: (code: P2pCancelReason, current: () => boolean) => Promise<ApiResult<Trade>>;
  onConfirmed: () => void;
  disabled: boolean;
}) {
  const { Copy, t } = cancelCopy.useCopy();
  const order = orderCopy.useCopy();
  const [code, setCode] = useState<P2pCancelReason | ''>('');
  const reasons: readonly P2pCancelReason[] = seller ? P2P_SELLER_CANCEL_REASONS : P2P_BUYER_CANCEL_REASONS;
  return (
    <div className="form-stack" data-testid="order-cancel">
      {seller ? null : (
        <p className="muted" role="note">
          <Copy k="paidWarning" />
        </p>
      )}
      <label>
        <Copy k="reasonLabel" />{' '}
        <select value={code} onChange={(event) => setCode(event.target.value as P2pCancelReason | '')}>
          <option value="">{t('reasonPick')}</option>
          {reasons.map((reason) => (
            <option key={reason} value={reason}>
              {t(`reason_${reason}`)}
            </option>
          ))}
        </select>
      </label>
      <ReviewedAction
        title={payCopy.t('cancelOrder')}
        description={order.t('cancelBody')}
        review={
          <div className="p2p-order-review">
            <PayDetails
              values={[
                ...reviewValues,
                [order.t('refundTo'), <span lang="zxx">{trade.sellerId}</span>],
                [payCopy.t('assetQuantity'), <PayAmount value={trade.amount} unit={trade.asset} label={payCopy.t('assetQuantity')} />],
                [
                  payCopy.t('externalPayment'),
                  <PayAmount value={trade.fiatAmount} unit={trade.fiatCurrency} label={payCopy.t('externalPayment')} />,
                ],
                [t('reasonGiven'), code ? t(`reason_${code}`) : t('noReasonCode')],
              ]}
            />
          </div>
        }
        ready={code !== ''}
        notReadyReason={t('reasonRequired')}
        perform={(current) => perform(code as P2pCancelReason, current)}
        onConfirmed={onConfirmed}
        disabled={disabled || code === ''}
        disabledReason={t('reasonRequired')}
      />
    </div>
  );
}

/**
 * P-trade-orders-19 (2) / J-p2p-06 #3: on a paid order the seller sees "Request cancellation", parked until the founders
 * choose how a paid order may be cancelled (ENGINE-SPEC section 5). The control stays visible with that blocker named;
 * svc-p2p `trades.requestCancel` refuses `p2p.owner_decision_pending` and writes nothing.
 */
export function RequestCancel() {
  const { Copy } = cancelCopy.useCopy();
  return (
    <div className="stack" data-testid="order-request-cancel">
      <Button variant="secondary" disabled aria-describedby="order-request-cancel-why">
        <Copy k="requestTitle" />
      </Button>
      <p className="muted" id="order-request-cancel-why">
        <Copy k="requestParked" />
      </p>
    </div>
  );
}

/**
 * P-trade-orders-19 / J-p2p-06 #8: on a cancelled order, who cancelled it and why, and the escrow returned to the seller
 * with the ledger's posting time (the refund posts once, under `p2p:escrow-refund:<tradeId>`).
 */
export function OrderRefund({ trade }: { trade: Trade }) {
  const { Copy, t } = cancelCopy.useCopy();
  const cancel = trade.cancelReason ?? null;
  const who: [string, ReactNode][] = cancel
    ? [
        [t('cancelledBy'), t(`by_${cancel.by}`)],
        ...(cancel.by === 'buyer' || cancel.by === 'seller'
          ? ([[t('reasonGiven'), cancel.code ? t(`reason_${cancel.code}`) : t('noReasonCode')]] satisfies [string, ReactNode][])
          : []),
      ]
    : [];
  if (trade.resolution === 'voided') {
    return (
      <section className="p2p-order-result" aria-label={t('refundTitle')} data-testid="order-refund">
        <PayDetails values={who} />
        <p className="muted">
          <Copy k="voided" />
        </p>
      </section>
    );
  }
  return (
    <section className="p2p-order-result" aria-label={t('refundTitle')} data-testid="order-refund">
      <h3>{t('refundTitle')}</h3>
      <PayDetails
        values={[
          ...who,
          [t('refundAmount'), <PayAmount value={trade.amount} unit={trade.asset} label={t('refundAmount')} />],
          [t('refundPosted'), trade.settledAt ? <PayTime value={trade.settledAt} /> : t('refundPending')],
        ]}
      />
    </section>
  );
}
