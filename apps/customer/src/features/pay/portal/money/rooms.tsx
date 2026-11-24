import './money.css';
import './refusals';
import type { ReactNode } from 'react';
import { Requires } from '../access/MerchantAccess';
import { WithAccount } from '../access/WithAccount';
import type { RoomDef, RoomTable } from '../rooms-model';
import { ApprovalsRoom } from './Approvals';
import { LinkButton } from './common';
import { mc } from './copy';
import { ConversionNewRoom } from './Conversion';
import { ConversionOrderRoom, ConversionRoom } from './ConversionOrders';
import { DestinationsRoom } from './Destinations';
import { LimitsRoom } from './Limits';
import { MerchantMoney } from './Money';
import { PayoutRoom, PayoutsRoom } from './Payouts';
import { PayoutNewRoom } from './PayoutNew';
import { PricingRoom } from './Pricing';
import { RefundNewRoom } from './RefundNew';
import { RefundRoom, RefundsRoom } from './Refunds';
import { SettlementRoom, SettlementsRoom } from './Settlements';
import { StatementRoom } from './Statement';
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
  ownTitle: true,
  render: (_route, { portal }) => <ConversionNewRoom portal={portal} />,
};

const refundsHeader: RoomDef['header'] = (route) =>
  route.room === 'refunds'
    ? { title: t('pageRefunds'), purpose: t('purposeRefunds'), action: go('/pay/refunds/new', t('actIssueRefund'), true) }
    : route.room === 'refund-new'
      ? { title: t('pageRefundNew'), purpose: t('purposeRefundNew'), action: go('/pay/refunds', t('pageRefunds')) }
      : { title: t('pageRefund'), purpose: t('purposeRefund') };

/** The refunds list and one refund draw their own title row on the record-list template. */
const refunds: RoomDef = {
  header: refundsHeader,
  here: '/pay/refunds',
  ownTitle: true,
  render: (route, { portal }) =>
    route.room === 'refund' ? <RefundRoom portal={portal} refundId={route.param!} /> : <RefundsRoom portal={portal} />,
};

/** A new refund draws its own title row on the flow template. */
const refundNew: RoomDef = {
  header: refundsHeader,
  here: '/pay/refunds',
  ownTitle: true,
  render: (_route, { portal, authority }) => <RefundNewRoom portal={portal} authority={authority} />,
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
    ownTitle: true,
    render: (_route, { portal }) => <StatementRoom portal={portal} />,
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
  'refund-new': refundNew,
  refund: refunds,
  settlements: {
    header: () => ({ title: t('pageSettlements'), purpose: t('purposeSettlements'), action: go('/pay/payouts/new', t('actPayOut'), true) }),
    ownTitle: true,
    render: (_route, { portal }) => <SettlementsRoom portal={portal} />,
  },
  settlement: {
    header: () => ({ title: t('pageSettlement'), purpose: t('purposeSettlement') }),
    here: '/pay/settlements',
    ownTitle: true,
    render: (route, { portal }) => <SettlementRoom portal={portal} settlementId={route.param!} />,
  },
  payouts: {
    header: () => ({ title: t('pagePayouts'), purpose: t('purposePayouts'), action: go('/pay/payouts/new', t('actPayOut'), true) }),
    ownTitle: true,
    render: (_route, { portal }) => <PayoutsRoom portal={portal} />,
  },
  'payout-new': {
    header: () => ({
      title: t('pagePayoutNew'),
      purpose: t('purposePayoutNew'),
      action: go('/pay/payouts/destinations', t('pageDestinations')),
    }),
    here: '/pay/payouts',
    ownTitle: true,
    render: (_route, { portal }) => <PayoutNewRoom portal={portal} />,
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
    ownTitle: true,
    render: (route, { portal }) => <PayoutRoom portal={portal} payoutId={route.param!} />,
  },
  approvals: {
    header: () => ({ title: t('pageApprovals'), purpose: t('purposeApprovals') }),
    ownTitle: true,
    render: (_route, { portal }) => <ApprovalsRoom portal={portal} />,
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
