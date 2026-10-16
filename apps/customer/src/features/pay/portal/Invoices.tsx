import { PaySection } from '../components';
import { Arrives, CopyReference, PortalBack } from './ExtensionTools';
import { extensionCopy as c } from './extension-copy';

/** Main has subscription executions, but no standalone invoice entity or merchant invoice API. */
export function Invoices({ invoiceId }: { invoiceId?: string }) {
  return (
    <div className="stack">
      <PortalBack href={invoiceId ? '/pay/invoices' : '/pay/merchant'}>{invoiceId ? c.t('backInvoices') : c.t('backHome')}</PortalBack>
      {invoiceId && (
        <PaySection title={c.t('reference')}>
          <CopyReference value={invoiceId} />
        </PaySection>
      )}
      <Arrives>{c.t(invoiceId ? 'invoiceDetailGap' : 'invoiceGap')}</Arrives>
      <PaySection title={c.t('recurringInvoices')} description={c.t('recurringInvoicesBody')}>
        <a className="text-link" href="/pay/subscriptions">
          {c.t('openSubscriptions')}
        </a>
      </PaySection>
    </div>
  );
}
