import { useMerchantAccess } from '../../access/MerchantAccess';
import type { RoomTable } from '../../rooms-model';
import { LinkButton } from '../../volt/parts';
import { useSettingsBApi } from '../b-client';
import { AnalyticsRoom } from './Analytics';
import { analyticsCopy as c } from './copy';
import { FeesRoom } from './Fees';

const link = (href: string, label: string) => <LinkButton href={href}>{label}</LinkButton>;

/** Money here is test money unless the account is live. Until the account says it is live, it carries the TEST tag. */
function useIsTest(): boolean {
  const { access } = useMerchantAccess();
  return access.status === 'ready' ? access.kybStatus !== 'approved' : true;
}

function VolumeRoom() {
  return <AnalyticsRoom api={useSettingsBApi()} test={useIsTest()} />;
}
function FeesPage() {
  return <FeesRoom api={useSettingsBApi()} test={useIsTest()} />;
}

export const analyticsRooms: RoomTable = {
  analytics: {
    header: () => ({ title: c.t('volumeTitle'), purpose: c.t('volumePurpose'), action: link('/pay/analytics/fees', c.t('feesTitle')) }),
    ownTitle: true,
    render: () => <VolumeRoom />,
  },
  'analytics-fees': {
    header: () => ({ title: c.t('feesTitle'), purpose: c.t('feesPurpose'), action: link('/pay/analytics', c.t('volumeTitle')) }),
    here: '/pay/analytics',
    ownTitle: true,
    render: () => <FeesPage />,
  },
};
