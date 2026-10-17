import './settings.css';
import { Button } from '@intafaced/ui';
import { WithAccount } from '../access/WithAccount';
import { Gate } from '../components';
import { extensionCopy, portalCopy, settingsCopy } from './copy';
import { notLiveRoom } from '../ui/notLiveRoom';
import type { RoomTable } from '../rooms-model';
import { Compliance } from './Compliance';
import { Notifications } from './Notifications';
import { Onboarding } from './Onboarding';
import { Settings, SettingsNav } from './Settings';
import { NoBusiness } from '../access/NoBusiness';
import { InvitationsOnly, Team } from './Team';
import { analyticsRooms } from './analytics/rooms';
import { developersRooms } from './developers/rooms';
import { reportsRooms } from './reports/rooms';

const link = (href: string, label: string, variant: 'primary' | 'secondary' = 'secondary') => (
  <Button variant={variant} nativeButton={false} role="link" render={<a href={href} />}>
    {label}
  </Button>
);
const t = portalCopy.t;

const settingsHeader = (room: 'settings' | 'settings-notifications') => ({
  title: extensionCopy.t(room === 'settings-notifications' ? 'notificationSettings' : 'settingsTitle'),
  purpose: extensionCopy.t('settingsPurpose'),
  action: link('/pay/settings/notifications', extensionCopy.t('notificationSettings')),
});
export const settingsRooms: RoomTable = {
  compliance: {
    header: () => ({
      title: extensionCopy.t('complianceTitle'),
      purpose: extensionCopy.t('compliancePurpose'),
      action: link('/pay/onboarding/verification', extensionCopy.t('verificationAction'), 'primary'),
    }),
    render: (_route, { portal }) => <WithAccount>{() => <Compliance portal={portal} />}</WithAccount>,
  },
  settings: {
    header: () => settingsHeader('settings'),
    render: (_route, {}) => <WithAccount>{({ record }) => <Settings merchant={record} />}</WithAccount>,
  },
  'settings-notifications': {
    header: () => settingsHeader('settings-notifications'),
    here: '/pay/settings/notifications',
    render: (_route, { portal }) => (
      <WithAccount>
        {() => (
          <div className="stack">
            <SettingsNav />
            <Notifications portal={portal} preferencesOnly />
          </div>
        )}
      </WithAccount>
    ),
  },
  ...developersRooms,
  ...reportsRooms,
  ...analyticsRooms,
  onboarding: {
    withoutBusiness: 'render',
    header: (route) => ({
      title: route.step
        ? t(route.step === 'business' ? 'step1Title' : route.step === 'verification' ? 'step2Title' : 'step3Title')
        : t('pageOnboarding'),
      purpose: t('purposeOnboarding'),
      action: link('/pay/merchant', t('openDashboard'), 'primary'),
    }),
    render: (route, { portal, access, starterFeeBps }) => (
      <Gate resource={access.merchant} retry={access.reloadMerchant} rows={4}>
        {(record) => (
          <Onboarding
            step={route.step}
            portal={portal}
            merchant={record}
            reloadMerchant={access.reloadMerchant}
            starterFeeBps={starterFeeBps}
          />
        )}
      </Gate>
    ),
  },
  team: {
    header: () => ({ title: t('pageTeam'), purpose: t('purposeTeam'), action: link('#invite', t('actInvite'), 'primary') }),
    withoutBusiness: ({ portal }) => (
      <NoBusiness>
        <InvitationsOnly portal={portal} />
      </NoBusiness>
    ),
    render: (_route, { portal }) => <Team portal={portal} />,
  },
  notifications: {
    header: () => ({ title: t('pageNotifications'), purpose: t('purposeNotifications') }),
    render: (_route, { portal }) => <Notifications portal={portal} />,
  },
  network: notLiveRoom(
    () => ({
      title: settingsCopy.t('networkTitle'),
      purpose: settingsCopy.t('networkPurpose'),
      body: settingsCopy.t('networkSoon'),
    }),
    'reasonNetwork',
    undefined,
    'the network list page (Package 3); submerchant.list is on main',
  ),
  'network-child': notLiveRoom(
    () => ({
      title: settingsCopy.t('networkChildTitle'),
      purpose: settingsCopy.t('networkChildPurpose'),
      body: settingsCopy.t('networkChildSoon'),
    }),
    'reasonNetwork',
    '/pay/network',
    'the sub-merchant page (Package 3); submerchant.get is on main',
  ),
  permissions: notLiveRoom(
    () => ({
      title: settingsCopy.t('permissionsTitle'),
      purpose: settingsCopy.t('permissionsPurpose'),
      body: settingsCopy.t('permissionsSoon'),
    }),
    'reasonNetwork',
    undefined,
    'the permissions page (Package 3); submerchantPermission.list is on main',
  ),
  'settings-security': notLiveRoom(
    () => ({
      title: settingsCopy.t('securityTitle'),
      purpose: settingsCopy.t('securityPurpose'),
      body: settingsCopy.t('securitySoon'),
    }),
    'reasonSecurity',
    '/pay/settings/security',
    'the security page (Package 3); identity session reads are on main',
  ),
  activity: notLiveRoom(
    () => ({
      title: settingsCopy.t('activityTitle'),
      purpose: settingsCopy.t('activityPurpose'),
      body: settingsCopy.t('activitySoon'),
    }),
    'reasonHistory',
    undefined,
    'merchantOps.activity.list (feat/pay-portal-be-audit-exports-webhooks)',
  ),
};
