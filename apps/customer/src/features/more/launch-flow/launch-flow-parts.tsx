import type { ReactNode } from 'react';
import { Button, Tag } from '@intafaced/ui/lit';
import { SectionTabs, type RoomState } from '@intafaced/ui/lit/templates';
import { appCopy } from '../../../app/app-copy';
import { navigate } from '../../../app/location';
import { safeReturnTo } from '../../../app/navigation';
import { useSession } from '../../session';
import { launchCatalogueCopy } from '../launch-catalogue-copy';
import { launchCopy } from '../launch-copy';
import { launchDepthCopy } from '../launch-depth-copy';
import type { LaunchTab } from '../LaunchAvailability';

/** The two Launch sections drawn on Volt, which switch in place, as the old room's tabs did. */
export type LaunchFlowTab = Extract<LaunchTab, 'Journey' | 'Check'>;

/** Where each of the three sections not yet on Volt opens, in the old Launch room (MoreRoutes' SECTION_TABS). */
const ELSEWHERE: Record<Exclude<LaunchTab, LaunchFlowTab>, string> = {
  Catalogue: '/launch',
  Requirements: '/launch/requirements',
  Participation: '/launch/mine',
};

/**
 * The Launch room's five sections as the kit's section tabs, the open one pressed (a row that scrolls when it overflows). The issuer journey and the pre-listing
 * check switch in place, as the old room's tabs did (Phantom 24 Oct); the other three open their own address.
 */
export function LaunchTabs({ current, onTab }: { current: LaunchFlowTab; onTab: (tab: LaunchFlowTab) => void }) {
  const { t } = launchDepthCopy.useCopy();
  const catalogue = launchCatalogueCopy.useCopy();
  return (
    <SectionTabs<LaunchTab>
      label={t('sections')}
      value={current}
      onChange={(tab) => (tab === 'Journey' || tab === 'Check' ? onTab(tab) : navigate(ELSEWHERE[tab]))}
      items={[
        { value: 'Catalogue', label: catalogue.t('tabCatalogue') },
        { value: 'Journey', label: t('tabJourney') },
        { value: 'Check', label: t('tabCheck') },
        { value: 'Requirements', label: t('tabRequirements') },
        { value: 'Participation', label: t('tabParticipation') },
      ]}
    />
  );
}

/** The line under the room's title: the Launch room's own scope, as the old page showed it. */
export function useLaunchScope(): string {
  return launchCopy.useCopy().t('scope');
}

/**
 * The issuer journey and the pre-listing check need an account. Signed out: the sign-in refusal the other More rooms
 * use (SignInPanel's words), returning to the section's own address (J-more-catalogue-01 #6). When the boot refresh
 * could not answer: never a false "signed out", but the retry refusal, with Retry as the room's one action. Either way the
 * section tabs stay, as they did above the sign-in panel, and the section's own body waits for the account.
 */
export function useLaunchGate(returnTo: string): { state: RoomState; blocked: boolean; retry: ReactNode } {
  const { t } = appCopy.useCopy();
  const { userId, restoreFailed, retryRestore } = useSession();
  if (userId) return { state: { kind: 'ready' }, blocked: false, retry: undefined };
  if (restoreFailed)
    return {
      state: {
        kind: 'ready',
        partial: {
          missing: {
            variant: 'unreachable',
            title: t('We could not check your sign-in'),
            body: t('The account service did not answer. Your sign-in is not lost; try again.'),
          },
        },
      },
      blocked: true,
      retry: <Button onClick={retryRestore}>{t('Retry')}</Button>,
    };
  return {
    state: {
      kind: 'ready',
      partial: {
        missing: {
          variant: 'refused',
          title: t('Sign in to continue'),
          body: t('Your account context is needed before this room can show private information.'),
          action: { label: t('Sign in'), href: `/login?redirect=${encodeURIComponent(safeReturnTo(returnTo))}` },
        },
      },
    },
    blocked: true,
    retry: undefined,
  };
}

/** A step's state word, toned by whether it can run today. */
export function StepMark({ state, children }: { state: 'ready' | 'paper' | 'blocked'; children: ReactNode }) {
  return <Tag tone={state === 'ready' ? 'up' : state === 'blocked' ? 'down' : 'neutral'}>{children}</Tag>;
}
