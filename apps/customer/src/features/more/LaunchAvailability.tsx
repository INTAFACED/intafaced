import { useState, type ReactNode } from 'react';
import { Tabs } from '../../shared/ui';
import { SessionRetryPanel, SignInPanel } from '../../app/SignInPanel';
import { useSession } from '../session';
import { launchDepthCopy } from './launch-depth-copy';
import { LaunchCheck, LaunchJourney, LaunchParticipation } from './LaunchRooms';
import { LaunchCatalogue } from './LaunchCatalogue';
import { launchCatalogueCopy } from './launch-catalogue-copy';
import { LaunchRequirements } from './launch-requirements/LaunchRequirementsRoom';

export type LaunchTab = 'Catalogue' | 'Journey' | 'Check' | 'Requirements' | 'Participation';
const TABS: readonly LaunchTab[] = ['Catalogue', 'Journey', 'Check', 'Requirements', 'Participation'];
/** The published launches, issuer journey, pre-listing check, requirements and participation. `tab`: the section an address such as /launch/check opens on. */
export function Launch({ orders = false, tab: first }: { orders?: boolean; tab?: LaunchTab }) {
  const [tab, setTab] = useState<LaunchTab>(first ?? (orders ? 'Participation' : 'Catalogue'));
  const { t } = launchDepthCopy.useCopy();
  const catalogue = launchCatalogueCopy.useCopy();
  const { userId, restoreFailed, retryRestore } = useSession();
  // The catalogue opens signed out (J-more-catalogue-11), and so does Requirements, which shows no account data. The
  // issuer journey, the pre-listing check and participation need an account: a signed-out visitor gets the sign-in
  // panel the other More rooms use (J-more-catalogue-01 #6) in their place, returning to the section's own address,
  // and the same panel above the catalogue. If the boot refresh could not answer, Retry, never a false "signed out".
  const signedOut = !userId && !restoreFailed;
  const priv = (section: ReactNode, returnTo: string) =>
    userId ? section : restoreFailed ? <SessionRetryPanel retry={retryRestore} /> : <SignInPanel returnTo={returnTo} />;
  return (
    <div className="lt-stack">
      <Tabs
        items={TABS}
        value={tab}
        onChange={(value) => setTab(value as LaunchTab)}
        label={t('sections')}
        labels={{
          Catalogue: catalogue.t('tabCatalogue'),
          Journey: t('tabJourney'),
          Check: t('tabCheck'),
          Requirements: t('tabRequirements'),
          Participation: t('tabParticipation'),
        }}
      />
      {tab === 'Catalogue' ? (
        <>
          {signedOut ? <SignInPanel>{catalogue.t('signInBrowse')}</SignInPanel> : null}
          <LaunchCatalogue />
        </>
      ) : tab === 'Journey' ? (
        priv(<LaunchJourney onTab={setTab} />, '/launch/new')
      ) : tab === 'Check' ? (
        priv(<LaunchCheck />, '/launch/check')
      ) : tab === 'Participation' ? (
        priv(<LaunchParticipation />, '/uc/innovation/myorders')
      ) : (
        <LaunchRequirements orders={false} />
      )}
    </div>
  );
}
