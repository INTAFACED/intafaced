import './analytics.css';
import { Button } from '@intafaced/ui';
import { useMerchantAccess } from '../../access/MerchantAccess';
import { WithAccount } from '../../access/WithAccount';
import type { RoomTable } from '../../rooms-model';
import { useSettingsBApi } from '../b-client';
import { Analytics } from './Analytics';
import { analyticsCopy as c } from './copy';
import { Fees } from './Fees';

const link = (href: string, label: string) => (
  <Button variant="secondary" nativeButton={false} role="link" render={<a href={href} />}>
    {label}
  </Button>
);

/** Money here is test money unless the account is live. Until the account says it is live, it carries the TEST tag. */
function useIsTest(): boolean {
  const { access } = useMerchantAccess();
  return access.status === 'ready' ? access.kybStatus !== 'approved' : true;
}

function VolumeRoom({ merchantId }: { merchantId: string }) {
  return <Analytics api={useSettingsBApi()} merchantId={merchantId} test={useIsTest()} />;
}
function FeesRoom({ merchantId }: { merchantId: string }) {
  return <Fees api={useSettingsBApi()} merchantId={merchantId} test={useIsTest()} />;
}

export const analyticsRooms: RoomTable = {
  analytics: {
    header: () => ({ title: c.t('volumeTitle'), purpose: c.t('volumePurpose'), action: link('/pay/analytics/fees', c.t('feesTitle')) }),
    render: () => <WithAccount>{({ merchantId }) => <VolumeRoom merchantId={merchantId} />}</WithAccount>,
  },
  'analytics-fees': {
    header: () => ({ title: c.t('feesTitle'), purpose: c.t('feesPurpose'), action: link('/pay/analytics', c.t('volumeTitle')) }),
    here: '/pay/analytics',
    render: () => <WithAccount>{({ merchantId }) => <FeesRoom merchantId={merchantId} />}</WithAccount>,
  },
};
