// volt-room: /academy/programmes
import { t as copyText } from '../copy';
import { AcademyProgrammes } from '../AcademyProgrammes';
import { useKitAcademyAction } from '../academy-reader/academy-action-kit';
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { AcademyVisitor, academyCatalogue } from './frame';
import { SignInNeeded } from './SignInNeeded';

/**
 * /academy/programmes on the catalogue template (intafaced issue 9566): the course programmes, path enrolment, grants,
 * ambassador status, residencies and tournament seasons. Signed out it says programmes need sign-in.
 */
export function AcademyProgrammesRoom({ signedIn }: { signedIn: boolean }) {
  if (!signedIn)
    return (
      <AcademyVisitor signedIn={false}>
        <CatalogueTemplate
          {...academyCatalogue({ current: 'Programmes' })}
          items={<SignInNeeded title={copyText('academy.programmes')} reason="publicProgrammesSignIn" />}
        />
      </AcademyVisitor>
    );
  return <SignedInProgrammes />;
}

function SignedInProgrammes() {
  const action = useKitAcademyAction();
  return (
    <>
      <AcademyVisitor signedIn>
        <CatalogueTemplate
          {...academyCatalogue({ current: 'Programmes', onLeave: action.retire })}
          items={
            <div className="lt-stack">
              <AcademyProgrammes action={action} />
              {action.feedback}
            </div>
          }
        />
      </AcademyVisitor>
      {action.dialog}
    </>
  );
}
