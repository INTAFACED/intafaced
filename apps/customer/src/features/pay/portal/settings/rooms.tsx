import './settings.css';
import { Button } from '@intafaced/ui';
import { WithAccount } from '../access/WithAccount';
import { extensionCopy, portalCopy, settingsCopy, w3cCopy } from './copy';
import { notLiveRoom } from '../ui/notLiveRoom';
import type { RoomDef, RoomTable } from '../rooms-model';
import { Developers, developerHeader } from './Developers';
import { Exports } from './Exports';
import { Notifications } from './Notifications';
import { Reports } from './Reports';
import { accountRooms } from './account/rooms';

const link = (href: string, label: string, variant: 'primary' | 'secondary' = 'secondary') => (
  <Button variant={variant} nativeButton={false} role="link" render={<a href={href} />}>
    {label}
  </Button>
);
const t = portalCopy.t;
const c = w3cCopy.t;

const settingsHeader = (room: 'settings' | 'settings-notifications') => ({
  title: extensionCopy.t(room === 'settings-notifications' ? 'notificationSettings' : 'settingsTitle'),
  purpose: extensionCopy.t('settingsPurpose'),
  action: link('/pay/settings/notifications', extensionCopy.t('notificationSettings')),
});
const developer: RoomDef = {
  header: developerHeader,
  here: '/pay/developer/keys',
  render: (route, { authority }) => <WithAccount>{() => <Developers route={route} authority={authority} />}</WithAccount>,
};

export const settingsRooms: RoomTable = {
  ...accountRooms,
  'settings-notifications': {
    header: () => settingsHeader('settings-notifications'),
    here: '/pay/settings/notifications',
    render: (_route, { portal }) => <WithAccount>{() => <Notifications portal={portal} preferencesOnly />}</WithAccount>,
  },
  'developer-keys': developer,
  'developer-signing': developer,
  'developer-webhooks': developer,
  'developer-endpoint': developer,
  'developer-deliveries': developer,
  reports: {
    header: () => ({
      title: c('reportsTitle'),
      purpose: c('reportsPurpose'),
      action: link('/pay/reports/exports', c('exportJobs'), 'primary'),
    }),
    render: (_route, {}) => <WithAccount>{() => <Reports />}</WithAccount>,
  },
  'report-exports': {
    header: () => ({ title: c('exportJobs'), purpose: c('exportJobsPurpose'), action: link('#request', c('reportAction'), 'primary') }),
    here: '/pay/reports',
    render: (_route, { portal }) => <Exports portal={portal} />,
  },
  notifications: {
    header: () => ({ title: t('pageNotifications'), purpose: t('purposeNotifications') }),
    render: (_route, { portal }) => <Notifications portal={portal} />,
  },
  'developer-sandbox': notLiveRoom(
    () => ({ title: settingsCopy.t('sandboxTitle'), purpose: settingsCopy.t('sandboxPurpose'), body: settingsCopy.t('sandboxSoon') }),
    'reasonActions',
    '/pay/developer/keys',
    'sandbox procedures callable from the portal',
  ),
  'developer-docs': notLiveRoom(
    () => ({ title: settingsCopy.t('docsTitle'), purpose: settingsCopy.t('docsPurpose'), body: settingsCopy.t('docsSoon') }),
    'reasonDocs',
    '/pay/developer/keys',
    'static developer docs (Package 3)',
  ),
  analytics: notLiveRoom(
    () => ({
      title: settingsCopy.t('analyticsTitle'),
      purpose: settingsCopy.t('analyticsPurpose'),
      body: settingsCopy.t('analyticsSoon'),
    }),
    'reasonLists',
    undefined,
    'merchantAnalytics.volume (feat/pay-portal-be-profile-analytics)',
  ),
  'analytics-fees': notLiveRoom(
    () => ({
      title: settingsCopy.t('analyticsFeesTitle'),
      purpose: settingsCopy.t('analyticsFeesPurpose'),
      body: settingsCopy.t('analyticsFeesSoon'),
    }),
    'reasonLists',
    '/pay/analytics',
    'merchantAnalytics.fees (feat/pay-portal-be-profile-analytics)',
  ),
};
