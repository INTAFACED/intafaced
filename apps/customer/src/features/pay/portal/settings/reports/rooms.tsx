import { Button } from '@intafaced/ui';
import { WithAccount } from '../../access/WithAccount';
import type { RoomTable } from '../../rooms-model';
import { useSettingsBApi } from '../b-client';
import { reportsCopy as c } from './copy';
import { Exports } from './Exports';
import { Reports } from './Reports';

const link = (href: string, label: string, variant: 'primary' | 'secondary' = 'secondary') => (
  <Button variant={variant} nativeButton={false} role="link" render={<a href={href} />}>
    {label}
  </Button>
);

export const reportsRooms: RoomTable = {
  reports: {
    header: () => ({
      title: c.t('reportsTitle'),
      purpose: c.t('reportsPurpose'),
      action: link('/pay/reports/exports#request', c.t('requestAction'), 'primary'),
    }),
    render: () => <WithAccount>{({ role }) => <ReportsRoom role={role} />}</WithAccount>,
  },
  'report-exports': {
    header: () => ({ title: c.t('exportsTitle'), purpose: c.t('exportsPurpose'), action: link('#request', c.t('requestAction')) }),
    here: '/pay/reports',
    render: () => <WithAccount>{({ role }) => <ExportsRoom role={role} />}</WithAccount>,
  },
};

function ReportsRoom({ role }: { role: string }) {
  return <Reports api={useSettingsBApi()} role={role} />;
}
function ExportsRoom({ role }: { role: string }) {
  return <Exports api={useSettingsBApi()} role={role} />;
}
