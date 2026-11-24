// volt-room: /academy
// volt-room: /academy/learning
import { useState } from 'react';
import { useSession } from '../../session';
import { AcademyHub } from '../AcademyHub';
import { AcademyLearning } from '../AcademyLearning';
import { AcademyMyLearning } from '../AcademyMyLearning';
import { rememberCertificate, selectedCertificate } from '../academy-learning-state';
import { useKitAcademyAction } from '../academy-reader/academy-action-kit';
import { LessonReaderStack } from '../academy-reader/LessonReader';
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { AcademyVisitor, academyCatalogue } from './frame';
import { PublicLearning } from './PublicLearning';

/**
 * /academy and /academy/learning on the catalogue template (intafaced issue 9566). /academy is the hub (what staff
 * featured, the news block) above Learning; /academy/learning is Learning alone. Signed in, Learning is my courses, the
 * catalogue, the learning path and the library, or the lesson an old `?slug=` address names; signed out it is the published
 * courses and the catalogue with search and sort.
 */
export function AcademyLearningRoom({
  hub,
  signedIn,
  slug,
  initialPath,
}: {
  hub: boolean;
  signedIn: boolean;
  slug?: string;
  initialPath?: string;
}) {
  if (!signedIn)
    return (
      <AcademyVisitor signedIn={false}>
        <CatalogueTemplate
          {...academyCatalogue({ current: 'Learning' })}
          featured={hub ? <AcademyHub /> : undefined}
          items={<PublicLearning />}
        />
      </AcademyVisitor>
    );
  return <SignedInLearning hub={hub} slug={slug} initialPath={initialPath} />;
}

/** The learner's Learning: the certificate they follow (the one they last chose), and the Academy's one staged action. */
function SignedInLearning({ hub, slug, initialPath }: { hub: boolean; slug?: string; initialPath?: string }) {
  const { userId } = useSession(),
    action = useKitAcademyAction();
  // A finished quiz or a watched video can meet an item's course rule: the outline beside it reads itself again.
  const [progressMade, setProgressMade] = useState(0);
  const [selection, setSelection] = useState(() => {
    const id = selectedCertificate(userId);
    rememberCertificate(userId, id);
    return { owner: userId, id };
  });
  const certId = selection.owner === userId ? selection.id : selectedCertificate(userId);
  function chooseCertificate(id: string) {
    action.retire();
    rememberCertificate(userId, id);
    setSelection({ owner: userId, id });
  }
  return (
    <>
      <AcademyVisitor signedIn>
        <CatalogueTemplate
          {...academyCatalogue({ current: 'Learning', onLeave: action.retire })}
          featured={hub ? <AcademyHub /> : undefined}
          items={
            <div className="lt-stack">
              {slug ? (
                <LessonReaderStack
                  slug={slug}
                  initialPath={initialPath}
                  certId={certId}
                  chooseCertificate={chooseCertificate}
                  action={action}
                  onProgress={() => setProgressMade((n) => n + 1)}
                  progress={progressMade}
                />
              ) : (
                <>
                  <AcademyMyLearning />
                  <AcademyLearning initialPath={initialPath} certId={certId} chooseCertificate={chooseCertificate} action={action} />
                </>
              )}
              {action.feedback}
            </div>
          }
        />
      </AcademyVisitor>
      {action.dialog}
    </>
  );
}
