import './money.css';
import { Button } from '@intafaced/ui';
import { Requires } from '../access/MerchantAccess';
import { WithAccount } from '../access/WithAccount';
import { moneyCopy, portalCopy, w3cCopy } from './copy';
import type { RoomDef, RoomTable } from '../rooms-model';
import { Approvals } from './Approvals';
import { Conversion, conversionHeader } from './Conversion';
import { Limits } from './Limits';
import { BalanceActivity, MerchantMoney } from './Money';
import { PayoutDetailPage, Payouts } from './Payouts';
import { Pricing } from './Pricing';
import { notLiveRoom } from '../ui/notLiveRoom';
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
  render: (route, { portal }) => (
    <WithAccount>{({ merchantId }) => <Conversion portal={portal} merchantId={merchantId} route={route} />}</WithAccount>
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
  render: (route, { portal, authority }) => (
    <WithAccount>
      {() => (
        <Requires need="owner">
          <Refunds portal={portal} refundId={route.param} create={route.room === 'refund-new'} authority={authority} />
        </Requires>
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
    render: (_route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="payments.read">
            <MerchantMoney portal={portal} merchantId={merchantId} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  'money-activity': {
    header: () => ({ title: c('statementTitle'), purpose: c('statementPurpose'), action: link('/pay/exports', c('exportJobs')) }),
    here: '/pay/money',
    render: (_route, {}) => <WithAccount>{() => <BalanceActivity />}</WithAccount>,
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
    render: (_route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="settlements.read">
            <Settlements portal={portal} merchantId={merchantId} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  settlement: {
    header: () => ({ title: t('pageSettlement'), purpose: t('purposeSettlement') }),
    here: '/pay/settlements',
    render: (route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="settlements.read">
            <SettlementDetailPage portal={portal} merchantId={merchantId} settlementId={route.param!} />
          </Requires>
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
    render: (_route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="settlements.read">
            <Payouts portal={portal} merchantId={merchantId} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  payout: {
    header: () => ({ title: t('pagePayout'), purpose: t('purposePayout') }),
    here: '/pay/payouts',
    render: (route, { portal }) => (
      <WithAccount>
        {({ merchantId, role, record }) => (
          <Requires need="settlements.read">
            <PayoutDetailPage portal={portal} merchantId={merchantId} payoutId={route.param!} role={role} merchant={record} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  approvals: {
    header: () => ({ title: t('pageApprovals'), purpose: t('purposeApprovals') }),
    render: (_route, { portal }) => (
      <WithAccount>{({ merchantId, role }) => <Approvals portal={portal} merchantId={merchantId} role={role} />}</WithAccount>
    ),
  },
  pricing: {
    header: () => ({ title: t('pagePricing'), purpose: t('purposePricing') }),
    render: (_route, { portal }) => <WithAccount>{({ merchantId }) => <Pricing portal={portal} merchantId={merchantId} />}</WithAccount>,
  },
  limits: {
    header: () => ({ title: t('pageLimits'), purpose: t('purposeLimits') }),
    render: (_route, { portal }) => (
      <WithAccount>{({ merchantId, record }) => <Limits portal={portal} merchantId={merchantId} merchant={record} />}</WithAccount>
    ),
  },
  'payout-new': notLiveRoom(
    () => ({ title: moneyCopy.t('payoutNewTitle'), purpose: moneyCopy.t('payoutNewPurpose'), body: moneyCopy.t('payoutNewSoon') }),
    'reasonActions',
    '/pay/payouts',
    'merchant.payoutDestinations.list (feat/pay-portal-be-reads-money)',
  ),
  'payout-destinations': notLiveRoom(
    () => ({
      title: moneyCopy.t('destinationsTitle'),
      purpose: moneyCopy.t('destinationsPurpose'),
      body: moneyCopy.t('destinationsSoon'),
    }),
    'reasonLists',
    '/pay/payouts/destinations',
    'merchant.payoutDestinations.list (feat/pay-portal-be-reads-money)',
  ),
};
