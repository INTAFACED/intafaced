import './money.css';
import './refusals';
import type { ReactNode } from 'react';
import { Requires } from '../access/MerchantAccess';
import { WithAccount } from '../access/WithAccount';
import type { RoomDef, RoomTable } from '../rooms-model';
import { Approvals } from './Approvals';
import { LinkButton } from './common';
import { mc } from './copy';
import { ConversionNew } from './Conversion';
import { ConversionOrderRoom, ConversionRoom } from './ConversionOrders';
import { DestinationsRoom } from './Destinations';
import { LimitsRoom } from './Limits';
import { MerchantMoney } from './Money';
import { PayoutDetailPage, Payouts } from './Payouts';
import { PayoutNew } from './PayoutNew';
import { PricingRoom } from './Pricing';
import { RefundDetail, RefundNew, Refunds } from './Refunds';
import { SettlementDetailPage, Settlements } from './Settlements';
import { Statement } from './Statement';
import { TopUp } from './TopUp';

const t = mc.t;
const go = (href: string, label: string, primary = false): ReactNode => (
  <LinkButton href={href} variant={primary ? 'primary' : 'secondary'}>
    {label}
  </LinkButton>
);

const conversionNew: RoomDef = {
  header: () => ({ title: t('pageConvertNew'), purpose: t('purposeConvertNew'), action: go('/pay/conversion', t('pageConversion')) }),
  here: '/pay/conversion',
  render: (_route, { portal }) => (
    <WithAccount>
      {({ merchantId }) => (
        <Requires need="payout.approve">
          <ConversionNew portal={portal} merchantId={merchantId} />
        </Requires>
      )}
    </WithAccount>
  ),
};

const refunds: RoomDef = {
  header: (route) =>
    route.room === 'refunds'
      ? { title: t('pageRefunds'), purpose: t('purposeRefunds'), action: go('/pay/refunds/new', t('actIssueRefund'), true) }
      : route.room === 'refund-new'
        ? { title: t('pageRefundNew'), purpose: t('purposeRefundNew'), action: go('/pay/refunds', t('pageRefunds')) }
        : { title: t('pageRefund'), purpose: t('purposeRefund') },
  here: '/pay/refunds',
  render: (route, { portal, authority }) => (
    <WithAccount>
      {({ merchantId }) =>
        route.room === 'refund-new' ? (
          <Requires need="owner">
            <RefundNew portal={portal} merchantId={merchantId} authority={authority} />
          </Requires>
        ) : (
          <Requires need="payments.read">
            {route.room === 'refund' ? (
              <RefundDetail portal={portal} refundId={route.param!} />
            ) : (
              <Refunds portal={portal} merchantId={merchantId} />
            )}
          </Requires>
        )
      }
    </WithAccount>
  ),
};

export const moneyRooms: RoomTable = {
  conversion: {
    header: () => ({
      title: t('pageConversion'),
      purpose: t('purposeConversion'),
      action: go('/pay/conversion/new', t('actConvert'), true),
    }),
    ownTitle: true,
    render: (_route, { portal }) => <ConversionRoom portal={portal} />,
  },
  'conversion-new': conversionNew,
  'conversion-order': {
    header: () => ({ title: t('pageConversionOrder'), purpose: t('purposeConversionOrder') }),
    here: '/pay/conversion',
    ownTitle: true,
    render: (route, { portal }) => <ConversionOrderRoom portal={portal} orderId={route.param!} />,
  },
  money: {
    header: () => ({ title: t('pageMoney'), purpose: t('purposeMoney'), action: go('/pay/payouts/new', t('actPayOut'), true) }),
    ownTitle: true,
    render: (_route, { portal }) => <MerchantMoney portal={portal} />,
  },
  'money-activity': {
    header: () => ({ title: t('pageStatement'), purpose: t('purposeStatement'), action: go('/pay/money', t('pageMoney')) }),
    here: '/pay/money',
    render: (_route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="settlements.read">
            <Statement portal={portal} merchantId={merchantId} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  'money-top-up': {
    header: () => ({ title: t('pageTopUp'), purpose: t('purposeTopUp'), action: go('/pay/money', t('pageMoney')) }),
    here: '/pay/money',
    render: (_route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="payments.read">
            <TopUp portal={portal} merchantId={merchantId} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  refunds,
  'refund-new': refunds,
  refund: refunds,
  settlements: {
    header: () => ({ title: t('pageSettlements'), purpose: t('purposeSettlements'), action: go('/pay/payouts/new', t('actPayOut'), true) }),
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
    header: () => ({ title: t('pagePayouts'), purpose: t('purposePayouts'), action: go('/pay/payouts/new', t('actPayOut'), true) }),
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
  'payout-new': {
    header: () => ({
      title: t('pagePayoutNew'),
      purpose: t('purposePayoutNew'),
      action: go('/pay/payouts/destinations', t('pageDestinations')),
    }),
    here: '/pay/payouts',
    render: (_route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="payout.request">
            <PayoutNew portal={portal} merchantId={merchantId} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  'payout-destinations': {
    header: () => ({
      title: t('pageDestinations'),
      purpose: t('purposeDestinations'),
      action: go('/pay/payouts/new', t('actPayOut')),
    }),
    here: '/pay/payouts',
    ownTitle: true,
    render: (_route, { portal }) => <DestinationsRoom portal={portal} />,
  },
  payout: {
    header: () => ({ title: t('pagePayout'), purpose: t('purposePayout') }),
    here: '/pay/payouts',
    render: (route, { portal }) => (
      <WithAccount>
        {({ merchantId, role }) => (
          <Requires need="settlements.read">
            <PayoutDetailPage portal={portal} merchantId={merchantId} payoutId={route.param!} role={role} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  approvals: {
    header: () => ({ title: t('pageApprovals'), purpose: t('purposeApprovals') }),
    render: (_route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="settlements.read">
            <Approvals portal={portal} merchantId={merchantId} />
          </Requires>
        )}
      </WithAccount>
    ),
  },
  pricing: {
    header: () => ({ title: t('pagePricing'), purpose: t('purposePricing') }),
    ownTitle: true,
    render: (_route, { portal }) => <PricingRoom portal={portal} />,
  },
  limits: {
    header: () => ({
      title: t('pageLimits'),
      purpose: t('purposeLimits'),
      action: go('/pay/limits#request', t('actRequestIncrease')),
    }),
    ownTitle: true,
    render: (_route, { portal }) => <LimitsRoom portal={portal} />,
  },
};
