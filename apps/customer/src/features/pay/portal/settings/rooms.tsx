import './settings.css';
import { Button } from '@intafaced/ui';
import { WithAccount } from '../access/WithAccount';
import { Gate } from '../components';
import { extensionCopy, portalCopy, settingsCopy, w3cCopy } from './copy';
import { comingSoonRoom } from '../ui/comingSoonRoom';
import type { RoomDef, RoomTable } from '../rooms-model';
import { Compliance } from './Compliance';
import { Developers, developerHeader } from './Developers';
import { Exports } from './Exports';
import { Notifications } from './Notifications';
import { Onboarding } from './Onboarding';
import { Reports } from './Reports';
import { Settings, SettingsNav } from './Settings';
import { Team } from './Team';

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
    render: (_route, { portal }) => <Team portal={portal} />,
  },
  notifications: {
    header: () => ({ title: t('pageNotifications'), purpose: t('purposeNotifications') }),
    render: (_route, { portal }) => <Notifications portal={portal} />,
  },
  network: comingSoonRoom(() => ({
    title: settingsCopy.t('networkTitle'),
    purpose: settingsCopy.t('networkPurpose'),
    body: settingsCopy.t('networkSoon'),
  })),
  'network-child': comingSoonRoom(
    () => ({
      title: settingsCopy.t('networkChildTitle'),
      purpose: settingsCopy.t('networkChildPurpose'),
      body: settingsCopy.t('networkChildSoon'),
    }),
    '/pay/network',
  ),
  permissions: comingSoonRoom(() => ({
    title: settingsCopy.t('permissionsTitle'),
    purpose: settingsCopy.t('permissionsPurpose'),
    body: settingsCopy.t('permissionsSoon'),
  })),
  'developer-sandbox': comingSoonRoom(
    () => ({ title: settingsCopy.t('sandboxTitle'), purpose: settingsCopy.t('sandboxPurpose'), body: settingsCopy.t('sandboxSoon') }),
    '/pay/developer/keys',
  ),
  'developer-docs': comingSoonRoom(
    () => ({ title: settingsCopy.t('docsTitle'), purpose: settingsCopy.t('docsPurpose'), body: settingsCopy.t('docsSoon') }),
    '/pay/developer/keys',
  ),
  analytics: comingSoonRoom(() => ({
    title: settingsCopy.t('analyticsTitle'),
    purpose: settingsCopy.t('analyticsPurpose'),
    body: settingsCopy.t('analyticsSoon'),
  })),
  'analytics-fees': comingSoonRoom(
    () => ({
      title: settingsCopy.t('analyticsFeesTitle'),
      purpose: settingsCopy.t('analyticsFeesPurpose'),
      body: settingsCopy.t('analyticsFeesSoon'),
    }),
    '/pay/analytics',
  ),
  'settings-security': comingSoonRoom(
    () => ({
      title: settingsCopy.t('securityTitle'),
      purpose: settingsCopy.t('securityPurpose'),
      body: settingsCopy.t('securitySoon'),
    }),
    '/pay/settings/security',
  ),
  activity: comingSoonRoom(() => ({
    title: settingsCopy.t('activityTitle'),
    purpose: settingsCopy.t('activityPurpose'),
    body: settingsCopy.t('activitySoon'),
  })),
};
