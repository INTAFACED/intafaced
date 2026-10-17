import './settings.css';
import { Button } from '@intafaced/ui';
import { WithAccount } from '../access/WithAccount';
import { Gate } from '../components';
import { portalCopy, extensionCopy, w3cCopy } from './copy';
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

const settingsHeader = (room: 'settings' | 'settings-team' | 'settings-notifications') => ({
  title: extensionCopy.t(
    room === 'settings-team' ? 'teamTitle' : room === 'settings-notifications' ? 'notificationSettings' : 'settingsTitle',
  ),
  purpose: extensionCopy.t('settingsPurpose'),
  action: link('/pay/settings/notifications', extensionCopy.t('notificationSettings')),
});
const developer: RoomDef = {
  header: developerHeader,
  here: '/pay/developer',
  render: (route, { authority, acct }) => <WithAccount {...acct}>{() => <Developers route={route} authority={authority} />}</WithAccount>,
};

export const settingsRooms: RoomTable = {
  compliance: {
    header: () => ({
      title: extensionCopy.t('complianceTitle'),
      purpose: extensionCopy.t('compliancePurpose'),
      action: link('/pay/onboarding/verification', extensionCopy.t('verificationAction'), 'primary'),
    }),
    render: (_route, { portal, acct }) => <WithAccount {...acct}>{() => <Compliance portal={portal} />}</WithAccount>,
  },
  settings: {
    header: () => settingsHeader('settings'),
    render: (_route, { acct }) => <WithAccount {...acct}>{({ record }) => <Settings merchant={record} />}</WithAccount>,
  },
  'settings-team': {
    header: () => settingsHeader('settings-team'),
    here: '/pay/settings',
    render: (_route, { portal }) => (
      <div className="stack">
        <SettingsNav />
        <Team portal={portal} />
      </div>
    ),
  },
  'settings-notifications': {
    header: () => settingsHeader('settings-notifications'),
    here: '/pay/settings',
    render: (_route, { portal, acct }) => (
      <WithAccount {...acct}>
        {() => (
          <div className="stack">
            <SettingsNav />
            <Notifications portal={portal} preferencesOnly />
          </div>
        )}
      </WithAccount>
    ),
  },
  developer,
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
    render: (_route, { acct }) => <WithAccount {...acct}>{() => <Reports />}</WithAccount>,
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
    render: (route, { portal, acct, starterFeeBps }) => (
      <Gate resource={acct.merchant} retry={acct.reload} rows={4}>
        {(record) => (
          <Onboarding step={route.step} portal={portal} merchant={record} reloadMerchant={acct.reload} starterFeeBps={starterFeeBps} />
        )}
      </Gate>
    ),
  },
  team: {
    header: () => ({ title: t('pageTeam'), purpose: t('purposeTeam'), action: link('#invite', t('actInvite'), 'primary') }),
    render: (_route, { portal }) => <Team portal={portal} />,
  },
  exports: {
    header: () => ({ title: t('pageExports'), purpose: t('purposeExports'), action: link('#request', t('actRequestExport'), 'primary') }),
    render: (_route, { portal }) => <Exports portal={portal} />,
  },
  notifications: {
    header: () => ({ title: t('pageNotifications'), purpose: t('purposeNotifications') }),
    render: (_route, { portal }) => <Notifications portal={portal} />,
  },
};
