import './payments.css';
import { Button } from '@intafaced/ui';
import { Requires } from '../access/MerchantAccess';
import { NoMerchant, WithAccount } from '../access/WithAccount';
import { Gate, PortalFailure, PortalLoading } from '../components';
import { extensionCopy, paymentsCopy, portalCopy, w3cCopy } from './copy';
import type { RoomDef, RoomTable } from '../rooms-model';
import { Customers, CustomerDetailPage } from './Customers';
import { Dashboard } from './Dashboard';
import { Disputes, DisputeDetailPage } from './Disputes';
import { Invoices } from './Invoices';
import { Links } from './Links';
import { PaymentDetailPage, Payments } from './Payments';
import { notLiveRoom } from '../ui/notLiveRoom';
import { Subscriptions, subscriptionHeader } from './Subscriptions';

const link = (href: string, label: string, variant: 'primary' | 'secondary' = 'secondary') => (
  <Button variant={variant} nativeButton={false} role="link" render={<a href={href} />}>
    {label}
  </Button>
);
const t = portalCopy.t;
const c = w3cCopy.t;

const subscriptions: RoomDef = {
  header: subscriptionHeader,
  here: '/pay/subscriptions',
  render: (route, { portal, authority }) => (
    <WithAccount>
      {({ merchantId }) => (
        <Requires need="owner">
          <Subscriptions portal={portal} merchantId={merchantId} route={route} authority={authority} />
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
  render: (route, { portal }) => (
    <WithAccount>
      {({ merchantId }) => (
        <Requires need={route.room === 'invoice-new' ? 'invoices.write' : 'invoices.read'}>
          <Invoices portal={portal} route={route} merchantId={merchantId} />
        </Requires>
      )}
    </WithAccount>
  ),
};
const links: RoomDef = {
  header: (route) =>
    route.room === 'links'
      ? { title: c('linksTitle'), purpose: c('linksPurpose'), action: link('/pay/links/new', c('linkNew'), 'primary') }
      : route.room === 'link-new'
        ? { title: c('linkNew'), purpose: c('linkNewPurpose'), action: link('/pay/links', c('backLinks')) }
        : { title: c('linkDetail'), purpose: c('linkDetailPurpose'), action: link('/pay/links/new', c('linkNew')) },
  here: '/pay/links',
  render: (route, { portal, authority }) => (
    <WithAccount>
      {({ merchantId }) => (
        <Requires need="owner">
          <Links portal={portal} merchantId={merchantId} create={route.room === 'link-new'} linkId={route.param} authority={authority} />
        </Requires>
      )}
    </WithAccount>
  ),
};

export const paymentsRooms: RoomTable = {
  subscriptions,
  subscription: subscriptions,
  'subscription-new': subscriptions,
  invoices,
  invoice: invoices,
  links,
  'link-new': links,
  link: links,
  dashboard: {
    header: () => ({
      title: t('pageDashboard'),
      purpose: t('purposeDashboard'),
      action: link('/pay/links/new', t('actCreateLink'), 'primary'),
    }),
    here: '/pay/merchant',
    render: (_route, { portal, access, legacyHome }) => (
      <Gate resource={access.merchant} retry={access.reloadMerchant} rows={5}>
        {(record) => {
          const a = access.access;
          if (a.status === 'loading') return <PortalLoading rows={5} />;
          if (a.status === 'failed') return <PortalFailure result={a.failure} />;
          if (a.status === 'none') return <NoMerchant />;
          return (
            <div className="stack">
              <Dashboard portal={portal} merchantId={a.merchantId} merchant={record} role={a.role} />
              {legacyHome}
            </div>
          );
        }}
      </Gate>
    ),
  },
  disputes: {
    header: () => ({ title: t('pageDisputes'), purpose: t('purposeDisputes') }),
    render: (_route, { portal }) => <Disputes portal={portal} />,
  },
  dispute: {
    header: () => ({ title: t('pageDispute'), purpose: t('purposeDispute') }),
    here: '/pay/disputes',
    render: (route, { portal }) => <DisputeDetailPage portal={portal} disputeId={route.param!} />,
  },
  customers: {
    header: () => ({ title: t('pageCustomers'), purpose: t('purposeCustomers') }),
    render: (_route, { portal }) => <Customers portal={portal} />,
  },
  customer: {
    header: () => ({ title: t('pageCustomer'), purpose: t('purposeCustomer') }),
    here: '/pay/customers',
    render: (route, { portal }) => <CustomerDetailPage portal={portal} customerRef={route.param!} />,
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
  'checkout-settings': notLiveRoom(
    () => ({
      title: paymentsCopy.t('checkoutSettingsTitle'),
      purpose: paymentsCopy.t('checkoutSettingsPurpose'),
      body: paymentsCopy.t('checkoutSettingsSoon'),
    }),
    'reasonLists',
    '/pay/checkout',
    'a read of the current checkout settings',
  ),
};
