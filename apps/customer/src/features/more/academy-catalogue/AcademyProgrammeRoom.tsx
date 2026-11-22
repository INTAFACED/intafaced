// volt-room: /academy/programmes/:slug
import { t as copyText } from '../copy';
import { AcademyProgrammePage } from '../AcademyProgrammesList';
import { useKitAcademyAction } from '../academy-reader/academy-action-kit';
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { AcademyVisitor, academyCatalogue } from './frame';
import { SignInNeeded } from './SignInNeeded';

/**
 * /academy/programmes/:slug on the catalogue template (intafaced issue 9566): one programme's courses in order with the
 * reader's state on each, its counts and its certificate, under Programmes. Signed out it says programmes need sign-in.
 */
export function AcademyProgrammeRoom({ slug, signedIn }: { slug: string; signedIn: boolean }) {
  if (!signedIn)
    return (
      <AcademyVisitor signedIn={false}>
        <CatalogueTemplate
          {...academyCatalogue({ current: 'Programmes', away: true })}
          items={<SignInNeeded title={copyText('academy.programmes')} reason="publicProgrammesSignIn" />}
        />
      </AcademyVisitor>
    );
  return <SignedInProgramme slug={slug} />;
}

function SignedInProgramme({ slug }: { slug: string }) {
  const action = useKitAcademyAction();
  return (
    <>
      <AcademyVisitor signedIn>
        <CatalogueTemplate
          {...academyCatalogue({ current: 'Programmes', away: true, onLeave: action.retire })}
          items={
            <div className="lt-stack">
              <AcademyProgrammePage slug={slug} />
              {action.feedback}
            </div>
          }
        />
      </AcademyVisitor>
      {action.dialog}
    </>
  );
}
