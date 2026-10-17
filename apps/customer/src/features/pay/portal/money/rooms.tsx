import './money.css';
import { Button } from '@intafaced/ui';
import { OwnerOnly, WithAccount } from '../access/WithAccount';
import { portalCopy, w3cCopy } from './copy';
import type { RoomDef, RoomTable } from '../rooms-model';
import { Approvals } from './Approvals';
import { Conversion, conversionHeader } from './Conversion';
import { Limits } from './Limits';
import { BalanceActivity, MerchantMoney } from './Money';
import { PayoutDetailPage, Payouts } from './Payouts';
import { Pricing } from './Pricing';
import { Refunds } from './Refunds';
import { SettlementDetailPage, Settlements } from './Settlements';

const link = (href: string, label: string, variant: 'primary' | 'secondary' = 'secondary') => (
  <Button variant={variant} nativeButton={false} role="link" render={<a href={href} />}>
    {label}
  </Button>
);
const t = portalCopy.t;
const c = w3cCopy.t;

const conversion: RoomDef = {
  header: conversionHeader,
  here: '/pay/conversion',
  render: (route, { portal, acct }) => (
    <WithAccount {...acct}>{({ merchantId }) => <Conversion portal={portal} merchantId={merchantId} route={route} />}</WithAccount>
  ),
};
const refunds: RoomDef = {
  header: (route) =>
    route.room === 'refunds'
      ? { title: c('refundsTitle'), purpose: c('refundsPurpose'), action: link('/pay/refunds/new', c('issueRefund'), 'primary') }
      : route.room === 'refund-new'
        ? { title: c('issueRefund'), purpose: c('issuePurpose'), action: link('/pay/payments', c('openPayments')) }
        : { title: c('refundTitle'), purpose: c('refundPurpose'), action: link('/pay/refunds', c('backRefunds')) },
  here: '/pay/refunds',
  render: (route, { portal, authority, acct }) => (
    <WithAccount {...acct}>
      {({ role }) => (
        <OwnerOnly role={role}>
          <Refunds portal={portal} refundId={route.param} create={route.room === 'refund-new'} authority={authority} />
        </OwnerOnly>
      )}
    </WithAccount>
  ),
};

export const moneyRooms: RoomTable = {
  conversion,
  'conversion-new': conversion,
  'conversion-order': conversion,
  money: {
    header: () => ({
      title: c('moneyTitle'),
      purpose: c('moneyPurpose'),
      action: link('/pay/money/activity', c('openStatement'), 'primary'),
    }),
    render: (_route, { portal, acct }) => (
      <WithAccount {...acct}>
        {({ merchantId, role }) => (
          <OwnerOnly role={role}>
            <MerchantMoney portal={portal} merchantId={merchantId} />
          </OwnerOnly>
        )}
      </WithAccount>
    ),
  },
  'money-activity': {
    header: () => ({ title: c('statementTitle'), purpose: c('statementPurpose'), action: link('/pay/exports', c('exportJobs')) }),
    here: '/pay/money',
    render: (_route, { acct }) => <WithAccount {...acct}>{() => <BalanceActivity />}</WithAccount>,
  },
  refunds,
  'refund-new': refunds,
  refund: refunds,
  settlements: {
    header: () => ({
      title: t('pageSettlements'),
      purpose: t('purposeSettlements'),
      action: link('/pay/settlements?view=tools', t('actSettlementTools'), 'primary'),
    }),
    render: (_route, { portal, acct }) => (
      <WithAccount {...acct}>
        {({ merchantId, role }) => (
          <OwnerOnly role={role}>
            <Settlements portal={portal} merchantId={merchantId} />
          </OwnerOnly>
        )}
      </WithAccount>
    ),
  },
  settlement: {
    header: () => ({ title: t('pageSettlement'), purpose: t('purposeSettlement') }),
    here: '/pay/settlements',
    render: (route, { portal, acct }) => (
      <WithAccount {...acct}>
        {({ merchantId, role }) => (
          <OwnerOnly role={role}>
            <SettlementDetailPage portal={portal} merchantId={merchantId} settlementId={route.param!} />
          </OwnerOnly>
        )}
      </WithAccount>
    ),
  },
  payouts: {
    header: () => ({
      title: t('pagePayouts'),
      purpose: t('purposePayouts'),
      action: link('/pay/payouts?view=tools', t('actRequestPayout'), 'primary'),
    }),
    render: (_route, { portal, acct }) => (
      <WithAccount {...acct}>
        {({ merchantId, role }) => (
          <OwnerOnly role={role}>
            <Payouts portal={portal} merchantId={merchantId} />
          </OwnerOnly>
        )}
      </WithAccount>
    ),
  },
  payout: {
    header: () => ({ title: t('pagePayout'), purpose: t('purposePayout') }),
    here: '/pay/payouts',
    render: (route, { portal, acct }) => (
      <WithAccount {...acct}>
        {({ merchantId, role, record }) => (
          <OwnerOnly role={role}>
            <PayoutDetailPage portal={portal} merchantId={merchantId} payoutId={route.param!} role={role} merchant={record} />
          </OwnerOnly>
        )}
      </WithAccount>
    ),
  },
  approvals: {
    header: () => ({ title: t('pageApprovals'), purpose: t('purposeApprovals') }),
    render: (_route, { portal, acct }) => (
      <WithAccount {...acct}>{({ merchantId, role }) => <Approvals portal={portal} merchantId={merchantId} role={role} />}</WithAccount>
    ),
  },
  pricing: {
    header: () => ({ title: t('pagePricing'), purpose: t('purposePricing') }),
    render: (_route, { portal, acct }) => (
      <WithAccount {...acct}>{({ merchantId }) => <Pricing portal={portal} merchantId={merchantId} />}</WithAccount>
    ),
  },
  limits: {
    header: () => ({ title: t('pageLimits'), purpose: t('purposeLimits') }),
    render: (_route, { portal, acct }) => (
      <WithAccount {...acct}>
        {({ merchantId, record }) => <Limits portal={portal} merchantId={merchantId} merchant={record} />}
      </WithAccount>
    ),
  },
};
