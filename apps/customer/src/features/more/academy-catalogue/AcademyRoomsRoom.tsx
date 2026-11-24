// volt-room: /academy/rooms
import { t as copyText } from '../copy';
import { AcademyCourseMessagesLink } from '../AcademyCourseMessages';
import { AcademyDiscussionCourses } from '../AcademyDiscussion';
import { AcademyRooms } from '../AcademyRooms';
import { useKitAcademyAction } from '../academy-reader/academy-action-kit';
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { AcademyVisitor, academyCatalogue } from './frame';
import { SignInNeeded } from './SignInNeeded';

/**
 * /academy/rooms on the catalogue template (intafaced issue 9566): the courses' discussions, the messages with course teams,
 * the learning rooms with their sessions, and hosting a room. Signed out it says the rooms need sign-in.
 */
export function AcademyRoomsRoom({ signedIn }: { signedIn: boolean }) {
  if (!signedIn)
    return (
      <AcademyVisitor signedIn={false}>
        <CatalogueTemplate
          {...academyCatalogue({ current: 'Rooms' })}
          items={<SignInNeeded title={copyText('academy.rooms')} reason="publicRoomsSignIn" />}
        />
      </AcademyVisitor>
    );
  return <SignedInRooms />;
}

function SignedInRooms() {
  const action = useKitAcademyAction();
  return (
    <>
      <AcademyVisitor signedIn>
        <CatalogueTemplate
          {...academyCatalogue({ current: 'Rooms', onLeave: action.retire })}
          items={
            <div className="lt-stack">
              <AcademyDiscussionCourses />
              <AcademyCourseMessagesLink />
              <AcademyRooms action={action} />
              {action.feedback}
            </div>
          }
        />
      </AcademyVisitor>
      {action.dialog}
    </>
  );
}
