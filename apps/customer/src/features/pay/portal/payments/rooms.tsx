import './payments.css';
import { Button } from '@intafaced/ui';
import { extensionCopy, paymentsCopy, portalCopy, w3cCopy } from './copy';
import type { RoomDef, RoomTable } from '../rooms-model';
import { CustomerRoom, CustomersRoom } from './Customers';
import { Dashboard } from './Dashboard';
import { DisputeRoom, DisputesRoom } from './Disputes';
import { InvoiceNewRoom } from './InvoiceCreate';
import { InvoiceRoom, InvoicesRoom } from './Invoices';
import { LinkNewRoom } from './Links';
import { LinksRoom } from './LinkList';
import { LinkButton } from '../volt/parts';
import { PaymentRoom, PaymentsRoom } from './Payments';
import { SubscriptionNewRoom, subscriptionHeader } from './Subscriptions';
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
  ownTitle: true,
  render: (_route, { portal, authority }) => <SubscriptionNewRoom portal={portal} authority={authority} />,
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
  ownTitle: true,
  render: (route, { portal }) =>
    route.room === 'invoice-new' ? (
      <InvoiceNewRoom portal={portal} />
    ) : route.room === 'invoice' && route.param ? (
      <InvoiceRoom portal={portal} invoiceId={route.param} />
    ) : (
      <InvoicesRoom portal={portal} />
    ),
};
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
  ownTitle: true,
  render: (_route, { portal, authority }) => <LinkNewRoom portal={portal} authority={authority} />,
};

export const paymentsRooms: RoomTable = {
  subscriptions,
  subscription: subscriptions,
  'subscription-new': subscriptionNew,
  invoices,
  invoice: invoices,
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
    ownTitle: true,
    render: (_route, { portal }) => <PaymentsRoom portal={portal} />,
  },
  payment: {
    header: () => ({
      title: t('pagePayment'),
      purpose: t('purposePayment'),
    }),
    here: '/pay/payments',
    ownTitle: true,
    render: (route, { portal }) => <PaymentRoom portal={portal} paymentId={route.param!} />,
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
