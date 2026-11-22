import './money.css';
import './refusals';
import type { ReactNode } from 'react';
import { Requires } from '../access/MerchantAccess';
import { WithAccount } from '../access/WithAccount';
import type { RoomDef, RoomTable } from '../rooms-model';
import { Approvals } from './Approvals';
import { LinkButton } from './common';
import { mc } from './copy';
import { Conversion, ConversionDetail, ConversionNew } from './Conversion';
import { Destinations } from './Destinations';
import { Limits } from './Limits';
import { MerchantMoney } from './Money';
import { PayoutDetailPage, Payouts } from './Payouts';
import { PayoutNew } from './PayoutNew';
import { Pricing } from './Pricing';
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
  conversion,
  'conversion-new': conversion,
  'conversion-order': conversion,
  money: {
    header: () => ({ title: t('pageMoney'), purpose: t('purposeMoney'), action: go('/pay/payouts/new', t('actPayOut'), true) }),
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
    render: (_route, { portal }) => (
      <WithAccount>
        {({ merchantId }) => (
          <Requires need="settlements.read">
            <Destinations portal={portal} merchantId={merchantId} />
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
    render: (_route, { portal }) => <WithAccount>{({ merchantId }) => <Pricing portal={portal} merchantId={merchantId} />}</WithAccount>,
  },
  limits: {
    header: () => ({
      title: t('pageLimits'),
      purpose: t('purposeLimits'),
      action: go('/pay/limits#request', t('actRequestIncrease')),
    }),
    render: (_route, { portal }) => <WithAccount>{({ merchantId }) => <Limits portal={portal} merchantId={merchantId} />}</WithAccount>,
  },
};
