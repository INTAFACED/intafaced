import './account.css';
import { Button } from '@intafaced/ui';
import { WithAccount } from '../../access/WithAccount';
import { readyAccess, useMerchantAccess } from '../../access/MerchantAccess';
import { Gate } from '../../components';
import type { RoomTable } from '../../rooms-model';
import { Activity } from '../activity/Activity';
import { Compliance } from '../onboarding/Compliance';
import { Onboarding } from '../onboarding/Onboarding';
import { BusinessSettings } from '../profile/BusinessSettings';
import { Security } from '../security/Security';
import { InvitationsOnly, Team } from '../team/Team';
import { NoBusiness } from '../../access/NoBusiness';
import { Network } from '../network/Network';
import { NetworkChild } from '../network/NetworkChild';
import { Permissions } from '../network/Permissions';
import { extensionCopy, portalCopy, settingsCopy } from '../copy';
import type { PortalApi } from '../../api';
import { accountCopy } from './copy';
import { OwnerSetsUp } from './ui';
import type { Access } from '../../access/resolve';

const link = (href: string, label: string, variant: 'primary' | 'secondary' = 'secondary') => (
  <Button variant={variant} nativeButton={false} role="link" render={<a href={href} />}>
    {label}
  </Button>
);
const t = portalCopy.t;

/** A person who belongs to a business without owning it. */
export const isTeamMember = (access: Access): boolean => access.status === 'ready' && access.role !== 'owner';

/** The account's own mode, for pages that belong to platform accounts only. */
function useMode(): string | null {
  return readyAccess(useMerchantAccess())?.mode ?? null;
}
function NetworkRoom({ portal }: { portal: PortalApi }) {
  const mode = useMode();
  return <WithAccount>{({ merchantId }) => <Network portal={portal} merchantId={merchantId} mode={mode} />}</WithAccount>;
}
function NetworkChildRoom({ portal, child }: { portal: PortalApi; child: string }) {
  const mode = useMode();
  return <WithAccount>{() => <NetworkChild portal={portal} childId={child} mode={mode} />}</WithAccount>;
}
function PermissionsRoom({ portal }: { portal: PortalApi }) {
  const mode = useMode();
  return <WithAccount>{({ merchantId }) => <Permissions portal={portal} merchantId={merchantId} mode={mode} />}</WithAccount>;
}

/** The pages the account package owns: setup, business details, team, security, activity and the platform network. */
export const accountRooms: RoomTable = {
  compliance: {
    header: () => ({
      title: extensionCopy.t('complianceTitle'),
      purpose: extensionCopy.t('compliancePurpose'),
      action: link('/pay/onboarding/verification', extensionCopy.t('verificationAction'), 'primary'),
    }),
    render: (_route, { portal }) => <WithAccount>{({ merchantId, role }) => <Compliance portal={portal} merchantId={merchantId} role={role} />}</WithAccount>,
  },
  settings: {
    header: () => ({
      title: accountCopy.t('businessTitle'),
      purpose: accountCopy.t('businessPurpose'),
    }),
    render: (_route, { portal }) => (
      <WithAccount>{({ merchantId }) => <BusinessSettings portal={portal} merchantId={merchantId} />}</WithAccount>
    ),
  },
  'settings-security': {
    header: () => ({ title: settingsCopy.t('securityTitle'), purpose: settingsCopy.t('securityPurpose') }),
    here: '/pay/settings/security',
    render: () => <WithAccount>{() => <Security />}</WithAccount>,
  },
  onboarding: {
    withoutBusiness: 'render',
    header: (route) => ({
      title: route.step
        ? t(route.step === 'business' ? 'step1Title' : route.step === 'verification' ? 'step2Title' : 'step3Title')
        : t('pageOnboarding'),
      purpose: t('purposeOnboarding'),
      action: link('/pay/merchant', t('openDashboard')),
    }),
    // A signed-in team member (a business exists, and they are not its owner) has nothing to set up: the owner does that.
    render: (route, { portal, access, starterFee }) =>
      isTeamMember(access.access) ? (
        <OwnerSetsUp />
      ) : (
        <Gate resource={access.merchant} retry={access.reloadMerchant} rows={4}>
          {(record) => (
            <Onboarding
              step={route.step}
              portal={portal}
              merchant={record}
              reloadMerchant={access.reloadMerchant}
              starterFee={starterFee}
            />
          )}
        </Gate>
      ),
  },
  team: {
    header: () => ({ title: t('pageTeam'), purpose: t('purposeTeam'), action: link('#invite', t('actInvite')) }),
    withoutBusiness: ({ portal }) => (
      <NoBusiness>
        <InvitationsOnly portal={portal} />
      </NoBusiness>
    ),
    render: (_route, { portal }) => <WithAccount>{() => <Team portal={portal} />}</WithAccount>,
  },
  activity: {
    header: () => ({ title: settingsCopy.t('activityTitle'), purpose: settingsCopy.t('activityPurpose') }),
    render: (_route, { portal }) => <WithAccount>{() => <Activity portal={portal} />}</WithAccount>,
  },
  network: {
    header: () => ({ title: settingsCopy.t('networkTitle'), purpose: settingsCopy.t('networkPurpose') }),
    render: (_route, { portal }) => <NetworkRoom portal={portal} />,
  },
  'network-child': {
    header: () => ({ title: settingsCopy.t('networkChildTitle'), purpose: settingsCopy.t('networkChildPurpose') }),
    here: '/pay/network',
    render: (route, { portal }) => <NetworkChildRoom portal={portal} child={route.param ?? ''} />,
  },
  permissions: {
    header: () => ({ title: settingsCopy.t('permissionsTitle'), purpose: settingsCopy.t('permissionsPurpose') }),
    render: (_route, { portal }) => <PermissionsRoom portal={portal} />,
  },
};
