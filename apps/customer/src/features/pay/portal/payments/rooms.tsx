import './payments.css';
import { Button } from '@intafaced/ui';
import { OwnerOnly, WithAccount, NoMerchant } from '../access/WithAccount';
import { Gate } from '../components';
import { portalCopy, w3cCopy, extensionCopy } from './copy';
import type { RoomDef, RoomTable } from '../rooms-model';
import type { MemberRole, MerchantRecord } from '../schemas';
import { Customers, CustomerDetailPage } from './Customers';
import { Dashboard } from './Dashboard';
import { Disputes, DisputeDetailPage } from './Disputes';
import { Invoices } from './Invoices';
import { Links } from './Links';
import { PaymentDetailPage, Payments } from './Payments';
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
  render: (route, { portal, authority, acct }) => (
    <WithAccount {...acct}>
      {({ merchantId, role }) => (
        <OwnerOnly role={role}>
          <Subscriptions portal={portal} merchantId={merchantId} route={route} authority={authority} />
        </OwnerOnly>
      )}
    </WithAccount>
  ),
};
const invoices: RoomDef = {
  header: (route) => ({
    title: extensionCopy.t(route.room === 'invoice' ? 'invoiceTitle' : 'invoicesTitle'),
    purpose: extensionCopy.t('invoicesPurpose'),
    action: link('/pay/subscriptions', extensionCopy.t('openSubscriptions')),
  }),
  here: '/pay/invoices',
  render: (route, { acct }) => <WithAccount {...acct}>{() => <Invoices invoiceId={route.param} />}</WithAccount>,
};
const links: RoomDef = {
  header: (route) =>
    route.room === 'links'
      ? { title: c('linksTitle'), purpose: c('linksPurpose'), action: link('/pay/links/new', c('linkNew'), 'primary') }
      : route.room === 'link-new'
        ? { title: c('linkNew'), purpose: c('linkNewPurpose'), action: link('/pay/links', c('backLinks')) }
        : { title: c('linkDetail'), purpose: c('linkDetailPurpose'), action: link('/pay/links/new', c('linkNew')) },
  here: '/pay/links',
  render: (route, { portal, authority, acct }) => (
    <WithAccount {...acct}>
      {({ merchantId, role }) => (
        <OwnerOnly role={role}>
          <Links portal={portal} merchantId={merchantId} create={route.room === 'link-new'} linkId={route.param} authority={authority} />
        </OwnerOnly>
      )}
    </WithAccount>
  ),
};

type Account = { merchantId: string; record: MerchantRecord | null; role: MemberRole | null };

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
      action: link('/pay/links', t('actCreateLink'), 'primary'),
    }),
    here: '/pay/merchant',
    render: (_route, { portal, acct, legacyHome }) => (
      <Gate resource={acct.merchant} retry={acct.reload} rows={5}>
        {(record) => {
          const team = acct.team;
          const account: Account | null = record
            ? { merchantId: record.id, record, role: team.status === 'ready' ? team.data.role : null }
            : team.status === 'ready'
              ? { merchantId: team.data.merchantId, record: null, role: team.data.role }
              : null;
          if (!account) return <NoMerchant />;
          return (
            <div className="stack">
              <Dashboard portal={portal} merchantId={account.merchantId} merchant={account.record} role={account.role} />
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
      action: link('/pay/payments?view=tools', t('actPaymentTools'), 'primary'),
    }),
    render: (_route, { portal, acct }) => (
      <WithAccount {...acct}>
        {({ merchantId, role }) => (
          <OwnerOnly role={role}>
            <Payments portal={portal} merchantId={merchantId} />
          </OwnerOnly>
        )}
      </WithAccount>
    ),
  },
  payment: {
    header: (route) => ({
      title: t('pagePayment'),
      purpose: t('purposePayment'),
      action: route.param
        ? link(`/pay/payments?view=tools&payment=${encodeURIComponent(route.param)}`, t('refundOrCapture'), 'primary')
        : undefined,
    }),
    here: '/pay/payments',
    render: (route, { portal, acct }) => (
      <WithAccount {...acct}>
        {({ role }) => (
          <OwnerOnly role={role}>
            <PaymentDetailPage portal={portal} paymentId={route.param!} />
          </OwnerOnly>
        )}
      </WithAccount>
    ),
  },
};
