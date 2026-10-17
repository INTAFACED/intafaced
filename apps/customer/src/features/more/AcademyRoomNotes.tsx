import { academyLmsCopy as copy } from './academy-lms-copy';
import { roomSummary } from './academy-lms';

type RoomFacts = { access: 'free' | 'staked' | 'invite'; minStake: string; capacity: number; hostId: string };
type SessionFacts = { status: 'scheduled' | 'live' | 'ended' | 'cancelled' };

/** What joining this room takes and which actions are the host's, said in plain words from the room's own terms. */
export function RoomNotes({
  room,
  sessions,
  userId,
}: {
  room: RoomFacts;
  sessions: readonly SessionFacts[];
  userId: string | null | undefined;
}) {
  const { Copy } = copy.useCopy();
  const summary = roomSummary(sessions);
  const isHost = Boolean(userId) && room.hostId === userId;
  return (
    <section className="academy-lms-stack" aria-label={copy.t('roomNotesLabel')}>
      <p role="status">
        <Copy k="roomSessions" params={{ live: summary.live, scheduled: summary.scheduled }} />
      </p>
      <p>
        {room.access === 'free' && <Copy k="roomFree" params={{ capacity: room.capacity }} />}
        {room.access === 'staked' && <Copy k="roomStaked" params={{ amount: room.minStake, capacity: room.capacity }} />}
        {room.access === 'invite' && <Copy k="roomInvite" params={{ capacity: room.capacity }} />}
      </p>
      {summary.live === 0 && (
        <p className="muted">
          <Copy k="roomNoLive" />
        </p>
      )}
      <p className="muted">
        <Copy k={isHost ? 'roomYouHost' : 'roomHostOnly'} />
      </p>
    </section>
  );
}
