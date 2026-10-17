import './settings.css';
import { Button } from '@intafaced/ui';
import { WithAccount } from '../access/WithAccount';
import { Gate } from '../components';
import { extensionCopy, portalCopy, settingsCopy, w3cCopy } from './copy';
import { notLiveRoom } from '../ui/notLiveRoom';
import type { RoomDef, RoomTable } from '../rooms-model';
import { Compliance } from './Compliance';
import { Developers, developerHeader } from './Developers';
import { Exports } from './Exports';
import { Notifications } from './Notifications';
import { Onboarding } from './Onboarding';
import { Reports } from './Reports';
import { Settings, SettingsNav } from './Settings';
import { NoBusiness } from '../access/NoBusiness';
import { InvitationsOnly, Team } from './Team';

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
