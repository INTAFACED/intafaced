import { useResource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { shortId } from '../model';
import { portalCopy } from './copy';

/** The payment a row is about: its reference and its customer. Reads the payment once the row is on screen; until then, and if that read fails, the reference alone. */
export function PaymentCell({ portal, paymentId }: { portal?: PortalApi; paymentId: string }) {
  const { t } = portalCopy.useCopy();
  const payment = useResource(
    (s) => (portal ? portal.payment(paymentId, s) : Promise.resolve({ ok: false as const, reason: 'not_supported' as const, message: '' })),
    `portal:row-payment:${paymentId}`,
  );
  const known = payment.resource.status === 'ready' ? payment.resource.data : null;
  return (
    <>
      <a className="text-link" href={`/pay/payments/${encodeURIComponent(paymentId)}`}>
        {t('disputePaymentRef', { ref: shortId(paymentId) })}
      </a>
      {known?.customerRef && <small className="pay-cell-note">{known.customerRef}</small>}
    </>
  );
}
