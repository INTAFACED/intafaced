// volt-room: /academy/learning/course/:slug/assignment/:itemId
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { t as copyText } from '../copy';
import { academyLmsCopy as copy } from '../academy-lms-copy';
import { AcademyAssignment } from '../AcademyAssignment';
import { AcademySignIn } from '../academy-kit-parts';
import { AcademySectionTabs } from '../academy-sections';
import { AcademyVisitor } from '../academy-catalogue/frame';
import { EmptyNote, Section } from '../volt-parts';

/**
 * `/academy/learning/course/:slug/assignment/:itemId` on the flow template: the assignment brief, hand-in form,
 * learner submissions, peer review and grade when signed in; a sign-in prompt when signed out.
 */
export function AcademyAssignmentRoom({ slug, itemId, signedIn }: { slug: string; itemId: string; signedIn: boolean }) {
  const { t } = copy.useCopy();
  return (
    <AcademyVisitor signedIn={signedIn}>
      <FlowTemplate
        title={copyText('moreroutes.academy')}
        description={copyText('moreroutes.learn.practise.and.join.hosted.sessions')}
        state={{ kind: 'ready' }}
        step={
          <div className="lt-stack">
            <AcademySectionTabs current="Learning" away />
            {signedIn ? (
              <AcademyAssignment key={itemId} slug={slug} itemId={itemId} />
            ) : (
              <Section title={copyText('academy.learning')}>
                <EmptyNote title={t('asgSignIn')} action={<AcademySignIn />} />
              </Section>
            )}
          </div>
        }
      />
    </AcademyVisitor>
  );
}
