import './money.css';
import './refusals';
import type { ReactNode } from 'react';
import { Requires } from '../access/MerchantAccess';
import { WithAccount } from '../access/WithAccount';
import type { RoomDef, RoomTable } from '../rooms-model';
import { ApprovalsRoom } from './Approvals';
import { LinkButton } from './common';
import { mc } from './copy';
import { Conversion, ConversionDetail, ConversionNew } from './Conversion';
import { DestinationsRoom } from './Destinations';
import { LimitsRoom } from './Limits';
import { MerchantMoney } from './Money';
import { PayoutRoom, PayoutsRoom } from './Payouts';
import { PayoutNew } from './PayoutNew';
import { PricingRoom } from './Pricing';
import { RefundNew } from './RefundNew';
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

const conversion: RoomDef = {
  header: (route) =>
    route.room === 'conversion-new'
      ? { title: t('pageConvertNew'), purpose: t('purposeConvertNew'), action: go('/pay/conversion', t('pageConversion')) }
      : route.room === 'conversion-order'
        ? { title: t('pageConversionOrder'), purpose: t('purposeConversionOrder') }
        : { title: t('pageConversion'), purpose: t('purposeConversion'), action: go('/pay/conversion/new', t('actConvert'), true) },
  here: '/pay/conversion',
  render: (route, { portal }) => (
    <WithAccount>
      {({ merchantId }) =>
        route.room === 'conversion-new' ? (
          <Requires need="payout.approve">
            <ConversionNew portal={portal} merchantId={merchantId} />
          </Requires>
        ) : route.room === 'conversion-order' ? (
          <ConversionDetail portal={portal} orderId={route.param!} />
        ) : (
          <Conversion portal={portal} merchantId={merchantId} />
        )
      }
    </WithAccount>
  ),
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

/** A new refund is a flow page: the frame keeps its heading. */
const refundNew: RoomDef = {
  header: refundsHeader,
  here: '/pay/refunds',
  render: (_route, { portal, authority }) => (
    <WithAccount>
      {({ merchantId }) => (
        <Requires need="owner">
          <RefundNew portal={portal} merchantId={merchantId} authority={authority} />
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
