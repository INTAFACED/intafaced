import type { RoomTable } from '../../rooms-model';
import { LinkButton } from '../../volt/parts';
import { reportsCopy as c } from './copy';
import { ExportsRoom } from './Exports';
import { ReportsRoom } from './Reports';

/** The heading's one action: a link drawn as one of the kit's buttons (both pages are on the record-list template). */
const link = (href: string, label: string, tone: 'primary' | 'secondary' = 'secondary') => (
  <LinkButton href={href} tone={tone}>
    {label}
  </LinkButton>
);

export const reportsRooms: RoomTable = {
  reports: {
    header: () => ({
      title: c.t('reportsTitle'),
      purpose: c.t('reportsPurpose'),
      action: link('/pay/reports/exports#request', c.t('requestAction'), 'primary'),
    }),
    ownTitle: true,
    render: () => <ReportsRoom />,
  },
  'report-exports': {
    header: () => ({ title: c.t('exportsTitle'), purpose: c.t('exportsPurpose'), action: link('#request', c.t('requestAction')) }),
    here: '/pay/reports',
    ownTitle: true,
    render: () => <ExportsRoom />,
  },
};
