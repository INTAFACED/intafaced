import './payments.css';
import { Button } from '@intafaced/ui';
import { Requires } from '../access/MerchantAccess';
import { WithAccount } from '../access/WithAccount';
import { extensionCopy, paymentsCopy, portalCopy, w3cCopy } from './copy';
import type { RoomDef, RoomTable } from '../rooms-model';
import { CustomerRoom, CustomersRoom } from './Customers';
import { Dashboard } from './Dashboard';
import { DisputeRoom, DisputesRoom } from './Disputes';
import { InvoiceCreate } from './InvoiceCreate';
import { InvoiceRoom, InvoicesRoom } from './Invoices';
import { Links } from './Links';
import { LinksRoom } from './LinkList';
import { LinkButton } from '../volt/parts';
import { PaymentDetailPage, Payments } from './Payments';
import { Subscriptions, subscriptionHeader } from './Subscriptions';
import { SubscriptionsRoom } from './SubscriptionList';
import { CheckoutSettingsRoom } from './CheckoutSettings';

const link = (href: string, label: string, variant: 'primary' | 'secondary' = 'secondary') => (
  <Button variant={variant} nativeButton={false} role="link" render={<a href={href} />}>
    {label}
  </Button>
);
const t = portalCopy.t;
const c = w3cCopy.t;
const e = extensionCopy.t;

/** `/pay/subscriptions` and `/pay/subscriptions/:subscriptionId` on the record-list template (`./SubscriptionList`). */
const subscriptions: RoomDef = {
  header: (route) => ({
    title: e(route.room === 'subscription' ? 'subscriptionTitle' : 'subscriptionsTitle'),
    purpose: e('subscriptionsPurpose'),
    action: (
      <LinkButton href="/pay/subscriptions/new" tone="primary">
        {e('createSubscription')}
      </LinkButton>
    ),
  }),
  here: '/pay/subscriptions',
  ownTitle: true,
  render: (route, { portal, authority }) => <SubscriptionsRoom portal={portal} subscriptionId={route.param} authority={authority} />,
};
const subscriptionNew: RoomDef = {
  header: subscriptionHeader,
  here: '/pay/subscriptions',
  render: (_route, { portal, authority }) => (
    <WithAccount>
      {({ merchantId }) => (
        <Requires need="owner">
          <Subscriptions portal={portal} merchantId={merchantId} authority={authority} />
        </Requires>
      )}
    </WithAccount>
  ),
};
const invoices: RoomDef = {
  header: (route) =>
    route.room === 'invoices'
      ? {
          title: paymentsCopy.t('invoicesTitle'),
          purpose: paymentsCopy.t('invoicesPurpose'),
          action: link('/pay/invoices/new', paymentsCopy.t('inv_create'), 'primary'),
        }
      : route.room === 'invoice-new'
        ? { title: paymentsCopy.t('inv_createTitle'), purpose: paymentsCopy.t('invoiceNewPurpose') }
        : { title: paymentsCopy.t('invoiceTitle'), purpose: paymentsCopy.t('invoicePurpose') },
  here: '/pay/invoices',
  render: (route, { portal }) =>
    route.room === 'invoice-new' ? (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="invoices.write">
            <InvoiceCreate portal={portal} merchantId={merchantId} />
          </Requires>
        )}
      </WithAccount>
    ) : route.room === 'invoice' && route.param ? (
      <InvoiceRoom portal={portal} invoiceId={route.param} />
    ) : (
      <InvoicesRoom portal={portal} />
    ),
};
/** The list and a record's own page draw their title row on the record-list template; the create form keeps the frame's. */
const invoicesOnVolt: RoomDef = { ...invoices, ownTitle: true };
/** `/pay/links` and `/pay/links/:linkId` on the record-list template (`./LinkList`), which draws their heading. */
const links: RoomDef = {
  header: (route) =>
    route.room === 'links'
      ? {
          title: c('linksTitle'),
          purpose: c('linksPurpose'),
          action: (
            <LinkButton href="/pay/links/new" tone="primary">
              {c('linkNew')}
            </LinkButton>
          ),
        }
      : { title: c('linkDetail'), purpose: c('linkDetailPurpose'), action: <LinkButton href="/pay/links/new">{c('linkNew')}</LinkButton> },
  here: '/pay/links',
  ownTitle: true,
  render: (route, { portal, authority }) => <LinksRoom portal={portal} linkId={route.param} authority={authority} />,
};
const linkNew: RoomDef = {
  header: () => ({ title: c('linkNew'), purpose: c('linkNewPurpose') }),
  here: '/pay/links',
  render: (_route, { portal, authority }) => (
    <WithAccount>
      {({ merchantId }) => (
        <Requires need="owner">
          <Links portal={portal} merchantId={merchantId} authority={authority} />
        </Requires>
      )}
    </WithAccount>
  ),
};

export const paymentsRooms: RoomTable = {
  subscriptions,
  subscription: subscriptions,
  'subscription-new': subscriptionNew,
  invoices: invoicesOnVolt,
  invoice: invoicesOnVolt,
  links,
  'link-new': linkNew,
  link: links,
  dashboard: {
    header: () => ({
      title: t('pageDashboard'),
      purpose: t('purposeDashboard'),
      action: link('/pay/links/new', t('actCreateLink'), 'primary'),
    }),
    here: '/pay/merchant',
    ownTitle: true,
    render: (_route, { portal }) => <Dashboard portal={portal} />,
  },
  disputes: {
    header: () => ({ title: t('pageDisputes'), purpose: t('purposeDisputes') }),
    ownTitle: true,
    render: (_route, { portal }) => <DisputesRoom portal={portal} />,
  },
  dispute: {
    header: () => ({ title: t('pageDispute'), purpose: t('purposeDispute') }),
    here: '/pay/disputes',
    ownTitle: true,
    render: (route, { portal }) => <DisputeRoom portal={portal} disputeId={route.param!} />,
  },
  customers: {
    header: () => ({ title: t('pageCustomers'), purpose: t('purposeCustomers') }),
    ownTitle: true,
    render: (_route, { portal }) => <CustomersRoom portal={portal} />,
  },
  customer: {
    header: () => ({ title: t('pageCustomer'), purpose: t('purposeCustomer') }),
    here: '/pay/customers',
    ownTitle: true,
    render: (route, { portal }) => <CustomerRoom portal={portal} customerRef={route.param!} />,
  },
  payments: {
    header: () => ({
      title: t('pagePayments'),
      purpose: t('purposePayments'),
    }),
    render: (_route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="payments.read">
            <Payments portal={portal} merchantId={merchantId} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  payment: {
    header: () => ({
      title: t('pagePayment'),
      purpose: t('purposePayment'),
    }),
    here: '/pay/payments',
    render: (route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="payments.read">
            <PaymentDetailPage portal={portal} paymentId={route.param!} merchantId={merchantId} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  'invoice-new': invoices,
  'checkout-settings': {
    header: () => ({
      title: paymentsCopy.t('checkoutSettingsTitle'),
      purpose: paymentsCopy.t('checkoutSettingsPurpose'),
    }),
    here: '/pay/checkout',
    ownTitle: true,
    render: (_route, { portal, authority }) => <CheckoutSettingsRoom portal={portal} authority={authority} />,
  },
};
