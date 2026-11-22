import { useState } from 'react';
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { useSession } from '../../session';
import { t as copyText } from '../copy';
import { AcademySectionSwitch } from '../academy-sections';
import { rememberCertificate, selectedCertificate, useLearningState } from '../academy-learning-state';
import { AcademyCourseOutline } from '../AcademyCourseOutline';
import { useKitAcademyAction } from './academy-action-kit';
import { LearningPath, LessonArticle } from './LessonReader';
import { PublicLesson, PublicRelated } from './PublicLessonReader';

/**
 * /academy/:slug on the reading template (intafaced issue 9568): one lesson, under the Academy's sections with Learning
 * pressed. Signed in, the course outline sits beside it and the learning path after it; signed out it is the visitor's
 * published lesson with its related items, and keeps the visitor's marker.
 */
export function AcademyReaderRoom({ slug, initialPath, signedIn }: { slug: string; initialPath?: string; signedIn: boolean }) {
  if (!signedIn)
    return (
      <div data-academy-visitor="true">
        <ReadingTemplate
          title={copyText('moreroutes.academy')}
          description={copyText('moreroutes.learn.practise.and.join.hosted.sessions')}
          state={{ kind: 'ready' }}
          meta={<AcademySectionSwitch current="Learning" />}
          body={<PublicLesson slug={slug} />}
          related={<PublicRelated slug={slug} />}
        />
      </div>
    );
  return <SignedInReader slug={slug} initialPath={initialPath} />;
}

/** The learner's reader: the certificate they follow (from the address, else the one they last chose), and one staged action. */
function SignedInReader({ slug, initialPath }: { slug: string; initialPath?: string }) {
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
  const state = useLearningState({ slug, initialPath, certId, action });
  const onProgress = () => setProgressMade((n) => n + 1);
  return (
    <>
      <ReadingTemplate
        title={copyText('moreroutes.academy')}
        description={copyText('moreroutes.learn.practise.and.join.hosted.sessions')}
        state={{ kind: 'ready' }}
        meta={<AcademySectionSwitch current="Learning" onLeave={action.retire} />}
        toc={<AcademyCourseOutline key={slug} itemSlug={slug} refresh={action.result} progress={progressMade} />}
        body={
          <div className="lt-stack">
            <LessonArticle state={state} certId={certId} action={action} onProgress={onProgress} />
            {action.feedback}
          </div>
        }
        related={<LearningPath state={state} slug={slug} certId={certId} chooseCertificate={chooseCertificate} />}
      />
      {action.dialog}
    </>
  );
}
