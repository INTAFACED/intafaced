import { CatalogueTemplate, SectionTabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { useSession } from '../../session';
import { t as copyText } from '../copy';
import { launchCatalogueCopy } from '../launch-catalogue-copy';
import { launchCopy } from '../launch-copy';
import { launchDepthCopy } from '../launch-depth-copy';
import { LaunchCatalogue } from '../LaunchCatalogue';
import type { LaunchTab } from '../LaunchAvailability';
import { SignInNote } from '../sign-in-note';
import { preservePaperHref } from '../trade-context';

/** Each section's own address; /launch itself is the catalogue. */
const SECTIONS: Readonly<Record<Exclude<LaunchTab, 'Catalogue'>, string>> = {
  Journey: '/launch/new',
  Check: '/launch/check',
  Requirements: '/launch/requirements',
  Participation: '/launch/mine',
};

/**
 * /launch on the kit (J-more-catalogue-11 #1, #2): the published launches, open signed out, under the room's section
 * row. The catalogue is this room; every other section is a room of its own at its own address (`SECTIONS`), so its
 * button opens that address, keeping the simulated view when this one is simulated.
 */
export function LaunchRoom({ paper }: { paper: boolean }) {
  const { t } = launchDepthCopy.useCopy();
  const catalogue = launchCatalogueCopy.useCopy();
  const scope = launchCopy.useCopy().t('scope');
  const { userId, restoreFailed } = useSession();
  // The catalogue opens signed out; above it, the sign-in panel the other More rooms use. If the boot refresh could not
  // answer, nothing claims the visitor is signed out.
  const signedOut = !userId && !restoreFailed;
  return (
    <CatalogueTemplate
      title={copyText('moreroutes.launch')}
      description={scope}
      state={{ kind: 'ready' }}
      filters={
        <SectionTabs<LaunchTab>
          items={[
            { value: 'Catalogue', label: catalogue.t('tabCatalogue') },
            { value: 'Journey', label: t('tabJourney') },
            { value: 'Check', label: t('tabCheck') },
            { value: 'Requirements', label: t('tabRequirements') },
            { value: 'Participation', label: t('tabParticipation') },
          ]}
          value="Catalogue"
          onChange={(tab) => {
            if (tab !== 'Catalogue') navigate(preservePaperHref(SECTIONS[tab], paper));
          }}
          label={t('sections')}
        />
      }
      items={
        <>
          {signedOut ? <SignInNote>{catalogue.t('signInBrowse')}</SignInNote> : null}
          <LaunchCatalogue />
        </>
      }
    />
  );
}
