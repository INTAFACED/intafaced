import './account.css';
import { readyAccess, useMerchantAccess, type MerchantAccessValue } from '../../access/MerchantAccess';
import type { RoomTable } from '../../rooms-model';
import { ActivityRoom } from '../activity/Activity';
import { ComplianceRoom } from '../onboarding/Compliance';
import { OnboardingRoom } from '../onboarding/Onboarding';
import { BusinessSettingsRoom } from '../profile/BusinessSettings';
import { Security } from '../security/Security';
import { InvitationsOnly, TeamRoom } from '../team/Team';
import { NoBusiness } from '../../access/NoBusiness';
import { NetworkRoom as NetworkList } from '../network/Network';
import { NetworkChildRoom } from '../network/NetworkChild';
import { PermissionsRoom as PermissionsSettings } from '../network/Permissions';
import { LinkButton } from '../../volt/parts';
import { extensionCopy, portalCopy, settingsCopy } from '../copy';
import type { PortalApi } from '../../api';
import { accountCopy } from './copy';
import type { Access } from '../../access/resolve';

const t = portalCopy.t;

/** A person who belongs to a business without owning it. */
export const isTeamMember = (access: Access): boolean => access.status === 'ready' && access.role !== 'owner';

/**
 * No business, and this session may not open one: the service refused even `merchant.me` and the session carries no
 * `pay:onboard` (issued only with two-step sign-in). The setup page then starts with turning that on, not a refusal.
 */
const cannotOpenYet = ({ access, merchant, sessionScopes }: MerchantAccessValue): boolean =>
  access.status === 'none' &&
  merchant.status === 'failed' &&
  merchant.failure.reason === 'forbidden' &&
  !(sessionScopes?.has('pay:onboard') ?? false);

/** The account's own mode, for pages that belong to platform accounts only. */
function useMode(): string | null {
  return readyAccess(useMerchantAccess())?.mode ?? null;
}
function NetworkRoom({ portal }: { portal: PortalApi }) {
  return <NetworkList portal={portal} mode={useMode()} />;
}
function NetworkChildPage({ portal, child }: { portal: PortalApi; child: string }) {
  return <NetworkChildRoom portal={portal} childId={child} mode={useMode()} />;
}
function PermissionsRoom({ portal }: { portal: PortalApi }) {
  return <PermissionsSettings portal={portal} mode={useMode()} />;
}

/** The pages the account package owns: setup, business details, team, security, activity and the platform network. */
export const accountRooms: RoomTable = {
  compliance: {
    header: () => ({
      title: extensionCopy.t('complianceTitle'),
      purpose: extensionCopy.t('compliancePurpose'),
      action: (
        <LinkButton href="/pay/onboarding/verification" tone="primary">
          {extensionCopy.t('verificationAction')}
        </LinkButton>
      ),
    }),
    ownTitle: true,
    render: (_route, { portal }) => <ComplianceRoom portal={portal} />,
  },
  settings: {
    header: () => ({
      title: accountCopy.t('businessTitle'),
      purpose: accountCopy.t('businessPurpose'),
    }),
    ownTitle: true,
    render: (_route, { portal }) => <BusinessSettingsRoom portal={portal} />,
  },
  'settings-security': {
    header: () => ({ title: settingsCopy.t('securityTitle'), purpose: settingsCopy.t('securityPurpose') }),
    here: '/pay/settings/security',
    ownTitle: true,
    render: () => <Security />,
  },
  onboarding: {
    withoutBusiness: 'render',
    ownTitle: true,
    header: (route) => ({
      title: route.step
        ? t(route.step === 'business' ? 'step1Title' : route.step === 'verification' ? 'step2Title' : 'step3Title')
        : t('pageOnboarding'),
      purpose: t('purposeOnboarding'),
      action: <LinkButton href="/pay/merchant">{t('openDashboard')}</LinkButton>,
    }),
    // A signed-in team member (a business exists, and they are not its owner) has nothing to set up: the owner does that.
    render: (route, { portal, access, starterFee }) => (
      <OnboardingRoom
        step={route.step}
        portal={portal}
        access={access}
        starterFee={starterFee}
        blocked={isTeamMember(access.access) ? 'team' : cannotOpenYet(access) ? 'two-step' : null}
      />
    ),
  },
  team: {
    header: () => ({ title: t('pageTeam'), purpose: t('purposeTeam'), action: <LinkButton href="#invite">{t('actInvite')}</LinkButton> }),
    withoutBusiness: ({ portal }) => (
      <NoBusiness>
        <InvitationsOnly portal={portal} />
      </NoBusiness>
    ),
    ownTitle: true,
    render: (_route, { portal }) => <TeamRoom portal={portal} />,
  },
  activity: {
    header: () => ({ title: settingsCopy.t('activityTitle'), purpose: settingsCopy.t('activityPurpose') }),
    ownTitle: true,
    render: (_route, { portal }) => <ActivityRoom portal={portal} />,
  },
  network: {
    header: () => ({ title: settingsCopy.t('networkTitle'), purpose: settingsCopy.t('networkPurpose') }),
    ownTitle: true,
    render: (_route, { portal }) => <NetworkRoom portal={portal} />,
  },
  'network-child': {
    header: () => ({ title: settingsCopy.t('networkChildTitle'), purpose: settingsCopy.t('networkChildPurpose') }),
    here: '/pay/network',
    ownTitle: true,
    render: (route, { portal }) => <NetworkChildPage portal={portal} child={route.param ?? ''} />,
  },
  permissions: {
    header: () => ({ title: settingsCopy.t('permissionsTitle'), purpose: settingsCopy.t('permissionsPurpose') }),
    ownTitle: true,
    render: (_route, { portal }) => <PermissionsRoom portal={portal} />,
  },
};
