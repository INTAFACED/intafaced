import './settings.css';
import { Button } from '@intafaced/ui';
import { WithAccount } from '../access/WithAccount';
import { extensionCopy, portalCopy } from './copy';
import type { RoomTable } from '../rooms-model';
import { Notifications } from './Notifications';
import { accountRooms } from './account/rooms';
import { analyticsRooms } from './analytics/rooms';
import { developersRooms } from './developers/rooms';
import { reportsRooms } from './reports/rooms';

const link = (href: string, label: string, variant: 'primary' | 'secondary' = 'secondary') => (
  <Button variant={variant} nativeButton={false} role="link" render={<a href={href} />}>
    {label}
  </Button>
);
const t = portalCopy.t;

const settingsHeader = (room: 'settings' | 'settings-notifications') =>
  room === 'settings-notifications'
    ? {
        title: extensionCopy.t('notificationSettings'),
        purpose: t('purposeNotificationPrefs'),
        action: link('/pay/settings', extensionCopy.t('settingsTitle')),
      }
    : {
        title: extensionCopy.t('settingsTitle'),
        purpose: extensionCopy.t('settingsPurpose'),
        action: link('/pay/settings/notifications', extensionCopy.t('notificationSettings')),
      };
export const settingsRooms: RoomTable = {
  ...accountRooms,
  'settings-notifications': {
    header: () => settingsHeader('settings-notifications'),
    here: '/pay/settings/notifications',
    render: (_route, { portal }) => <WithAccount>{() => <Notifications portal={portal} preferencesOnly />}</WithAccount>,
  },
  ...developersRooms,
  ...reportsRooms,
  ...analyticsRooms,
  notifications: {
    header: () => ({ title: t('pageNotifications'), purpose: t('purposeNotifications') }),
    render: (_route, { portal }) => <Notifications portal={portal} />,
  },
};
