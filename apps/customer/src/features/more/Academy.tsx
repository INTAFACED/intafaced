import { useEffect } from 'react';
import { useSession } from '../session';
import { Tabs } from '../../shared/ui';
import { t as copyText } from './copy';
import { useAcademyAction } from './academy-action';
import { AcademyPublic } from './AcademyPublic';
import { CertificateVerifyPage } from './AcademyCertificates';
import { AcademyAssignment } from './AcademyAssignment';
import { AcademyDiscussionPage, AcademyDiscussionThread } from './AcademyDiscussion';
import { AcademyCourseConversation } from './AcademyCourseMessages';
import { AcademyInboxRoom } from './academy-inbox/AcademyInboxRoom';
import { academySectionRedirect, academyTabHref, academyTabs, type AcademyRoute } from './academy-lms';
import { navigate } from '../../app/location';

/** `/academy` and everything under it. An old `?section=` link is replaced by the tab's own address before anything reads. */
export function AcademyRoom({ pathname, search, route }: { pathname: string; search: string; route: AcademyRoute }) {
  const redirect = academySectionRedirect(pathname, search);
  useEffect(() => {
    if (redirect) navigate(redirect, true);
  }, [redirect]);
  const { userId } = useSession();
  if (redirect) return null;
  // A shared certificate link opens the same public check for everyone, signed in or not.
  if (route.kind === 'verify') return <CertificateVerifyPage code={route.code} />;
  // A visitor with no account gets the signed-out Academy.
  if (!userId) return <AcademyPublic route={route} />;
  return <Academy route={route} />;
}

/**
 * The Academy's pages not yet on their Volt template: an assignment, a course discussion and a conversation with a
 * course team. The five tabs are their own rooms (academy-catalogue/, AcademyCertificatesRoom.tsx).
 */
function Academy({ route }: { route: AcademyRoute }) {
  const action = useAcademyAction();
  // Each tab is its own address: a click pushes history, so the back button returns to the previous tab.
  const tab =
    route.kind === 'tab'
      ? route.tab
      : route.kind === 'reader' || route.kind === 'course' || route.kind === 'assignment'
        ? 'Learning'
        : route.kind === 'programme'
          ? 'Programmes'
          : route.kind === 'discussion' || route.kind === 'messages'
            ? 'Rooms'
            : '';
  // The course-team inbox is a record list on its Volt template: it draws its own title row and the Academy's tabs.
  if (route.kind === 'messages' && !route.conversationId) return <AcademyInboxRoom />;
  return (
    <div className="lt-stack">
      <Tabs
        items={academyTabs.map(([name]) => name)}
        labels={{
          Learning: copyText('academy.learning'),
          Certificates: copyText('academy.certificates'),
          Rooms: copyText('academy.rooms'),
          Videos: copyText('academy.videos'),
          Programmes: copyText('academy.programmes'),
        }}
        value={tab}
        onChange={(next) => {
          action.retire();
          const target = academyTabs.find(([name]) => name === next);
          // The open tab is already this address: a second push would make Back seem to do nothing.
          if (target && (next !== tab || route.kind !== 'tab')) navigate(academyTabHref(target[0]));
        }}
        label={copyText('academy.academy.sections')}
      />
      {route.kind === 'assignment' ? (
        <AcademyAssignment key={route.itemId} slug={route.slug ?? ''} itemId={route.itemId ?? ''} />
      ) : route.kind === 'discussion' ? (
        route.postId ? (
          <AcademyDiscussionThread key={route.postId} courseSlug={route.courseSlug} postId={route.postId} />
        ) : (
          <AcademyDiscussionPage key={route.courseSlug} courseSlug={route.courseSlug} />
        )
      ) : route.kind === 'messages' ? (
        route.conversationId ? (
          <AcademyCourseConversation key={route.conversationId} conversationId={route.conversationId} />
        ) : null
      ) : null}
      {action.feedback}
      {action.dialog}
    </div>
  );
}
