import './settings.css';
import { extensionCopy, portalCopy } from './copy';
import type { RoomTable } from '../rooms-model';
import { NotificationPreferencesRoom, Notifications } from './Notifications';
import { LinkButton } from '../volt/parts';
import { accountRooms } from './account/rooms';
import { analyticsRooms } from './analytics/rooms';
import { developersRooms } from './developers/rooms';
import { reportsRooms } from './reports/rooms';

const t = portalCopy.t;

const settingsHeader = (room: 'settings' | 'settings-notifications') =>
  room === 'settings-notifications'
    ? {
        title: extensionCopy.t('notificationSettings'),
        purpose: t('purposeNotificationPrefs'),
        action: <LinkButton href="/pay/settings">{extensionCopy.t('settingsTitle')}</LinkButton>,
      }
    : {
        title: extensionCopy.t('settingsTitle'),
        purpose: extensionCopy.t('settingsPurpose'),
        action: <LinkButton href="/pay/settings/notifications">{extensionCopy.t('notificationSettings')}</LinkButton>,
      };
export const settingsRooms: RoomTable = {
  ...accountRooms,
  'settings-notifications': {
    header: () => settingsHeader('settings-notifications'),
    here: '/pay/settings/notifications',
    ownTitle: true,
    render: (_route, { portal }) => <NotificationPreferencesRoom portal={portal} />,
  },
  ...developersRooms,
  ...reportsRooms,
  ...analyticsRooms,
  notifications: {
    header: () => ({ title: t('pageNotifications'), purpose: t('purposeNotifications') }),
    render: (_route, { portal }) => <Notifications portal={portal} />,
  },
};
