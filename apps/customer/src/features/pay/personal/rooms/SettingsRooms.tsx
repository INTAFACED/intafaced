// volt-room: /pay/contacts
// volt-room: /pay/send/limits
// volt-room: /pay/fees
// volt-room: /pay/preferences
// volt-room: /pay/contacts/groups/:groupId
// volt-room: /pay/contacts/pools/:poolId
import { useMemo, type ReactNode } from 'react';
import { Button, Checkbox, Select } from '@intafaced/ui/lit';
import { KeyValue, SettingsTemplate } from '@intafaced/ui/lit/templates';
import { useSession } from '../../../session';
import { contactLabel, contactsFrom, readSent, requestPath } from '../personal-model';
import { decodedSegment, type PersonalRoomMatch } from './rooms';
import { roomsCopy } from './rooms-copy';

type T = ReturnType<typeof roomsCopy.useCopy>['t'];

/** The personal Pay rooms on the settings template: Contacts, a group, a pool, Send limits, Fees and Pay preferences. */
export const SETTINGS_ROOM_IDS = new Set(['contacts', 'group', 'pool', 'limits', 'fees', 'preferences']);

/** One section of a room: its heading, which the index links to, and its rows. */
interface Part {
  id: string;
  title: string;
  body: ReactNode;
  testId?: string;
}

/** Why a room has nothing behind it yet, always on screen. `slice` is the work that connects it. */
function Blocked({ slice, children }: { slice: string; children: ReactNode }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div id="pay-room-reason" role="note" data-testid="pay-reason" data-slice={slice}>
      <p>
        <strong>{t('blockedTitle')}</strong>
      </p>
      <p>{children}</p>
    </div>
  );
}

/**
 * The room on its template: an index of its sections, the sections, the reason beside them, and the way back to Pay.
 * The template draws the title.
 */
function Room({
  title,
  line,
  parts,
  reason,
  slice,
}: {
  title: string;
  line: string;
  parts: readonly Part[];
  reason: ReactNode;
  slice: string;
}) {
  const { t } = roomsCopy.useCopy();
  return (
    <SettingsTemplate
      title={title}
      description={line}
      state={{ kind: 'ready' }}
      index={
        <nav aria-label={t('sectionsLabel')}>
          <ul>
            {parts.map((part) => (
              <li key={part.id}>
                <a className="lt-link" href={`#pay-room-${part.id}`}>
                  {part.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      }
      sections={
        <>
          {parts.map((part) => (
            <section key={part.id} id={`pay-room-${part.id}`} aria-labelledby={`pay-room-${part.id}-title`} data-testid={part.testId}>
              <h2 id={`pay-room-${part.id}-title`}>{part.title}</h2>
              {part.body}
            </section>
          ))}
          <p>
            {/* On its own line it is a control, not a word in a sentence: the kit's pill gives it a full-height target. */}
            <a className="lt-tab" href="/pay" data-testid="pay-room-back">
              {t('back')}
            </a>
          </p>
        </>
      }
      explain={<Blocked slice={slice}>{reason}</Blocked>}
    />
  );
}

/** A list the room has no service for: its empty line, and its one control, off and tied to the reason on screen. */
function Unstored({ empty, off }: { empty: string; off: string }) {
  return (
    <>
      <p className="lt-hint">{empty}</p>
      <div className="lt-actions">
        <Button tone="secondary" disabled aria-describedby="pay-room-reason">
          {off}
        </Button>
      </div>
    </>
  );
}

/** Facts the room cannot read: each one says it is not set, never a figure it does not have. */
function NotSet({ t, facts }: { t: T; facts: readonly string[] }) {
  return <KeyValue rows={facts.map((fact) => ({ label: fact, value: t('notSet'), unset: true }))} />;
}

function ContactsRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  const { userId } = useSession();
  const people = useMemo(() => (userId ? contactsFrom(readSent(userId), 50) : []), [userId]);
  const recent =
    people.length === 0 ? (
      <p className="lt-hint">{t('contactsRecentEmpty')}</p>
    ) : (
      <ul>
        {people.map((person) => (
          <li key={person.userId} data-testid="contact-row">
            <p>{contactLabel(person)}</p>
            <p className="lt-hint">{t('contactsTimes', { count: String(person.times) })}</p>
            <div className="lt-actions">
              <a className="lt-button lt-button-secondary" href={requestPath({ to: person.handle ?? person.userId })}>
                {t('contactsPay')}
              </a>
            </div>
          </li>
        ))}
      </ul>
    );
  return (
    <Room
      title={t('contactsTitle')}
      line={t('contactsLine')}
      slice={slice}
      reason={t('contactsReason')}
      parts={[
        { id: 'recent', title: t('contactsRecentTitle'), body: recent, testId: 'contacts-device' },
        { id: 'saved', title: t('contactsSaved'), body: <Unstored empty={t('contactsSavedEmpty')} off={t('contactsAdd')} /> },
        { id: 'groups', title: t('contactsGroups'), body: <Unstored empty={t('contactsGroupsEmpty')} off={t('contactsNewGroup')} /> },
        { id: 'pools', title: t('contactsPools'), body: <Unstored empty={t('contactsPoolsEmpty')} off={t('contactsNewPool')} /> },
      ]}
    />
  );
}

function GroupRoom({ kind, id, slice }: { kind: 'group' | 'pool'; id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  const pool = kind === 'pool';
  const rows: { label: string; value: string; unset?: boolean; ltr?: boolean }[] = [
    id ? { label: t('reference'), value: id, ltr: true } : { label: t('reference'), value: t('notSet'), unset: true },
  ];
  if (pool)
    rows.push({ label: t('poolAmount'), value: t('notSet'), unset: true }, { label: t('poolPaid'), value: t('notSet'), unset: true });
  return (
    <Room
      title={t(pool ? 'poolTitle' : 'groupTitle')}
      line={t(pool ? 'poolLine' : 'groupLine')}
      slice={slice}
      reason={t('groupReason')}
      parts={[
        { id: 'details', title: t('detailsTitle'), body: <KeyValue rows={rows} /> },
        { id: 'members', title: t('members'), body: <Unstored empty={t('membersEmpty')} off={t('addMember')} /> },
      ]}
    />
  );
}

function FactsRoom({
  title,
  line,
  facts,
  reason,
  slice,
}: {
  title: string;
  line: string;
  facts: readonly string[];
  reason: string;
  slice: string;
}) {
  const { t } = roomsCopy.useCopy();
  return (
    <Room
      title={title}
      line={line}
      slice={slice}
      reason={reason}
      parts={[{ id: 'details', title: t('detailsTitle'), body: <NotSet t={t} facts={facts} /> }]}
    />
  );
}

function PreferencesRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  const form = (
    <form noValidate onSubmit={(event) => event.preventDefault()}>
      <fieldset disabled aria-describedby="pay-room-reason">
        <legend className="lt-sr">{t('preferencesTitle')}</legend>
        <Select
          id="pay-pref-source"
          label={t('prefSource')}
          hint={t('prefSourceHint')}
          defaultValue=""
          options={[{ value: '', label: t('notSet') }]}
        />
        <Checkbox>{t('prefFind')}</Checkbox>
        <Checkbox>{t('prefReceipts')}</Checkbox>
      </fieldset>
    </form>
  );
  return (
    <Room
      title={t('preferencesTitle')}
      line={t('preferencesLine')}
      slice={slice}
      reason={t('preferencesReason')}
      parts={[{ id: 'preferences', title: t('preferencesSection'), body: form }]}
    />
  );
}

/** A signed-out visitor is sent to sign in and nothing is read. */
function SignIn() {
  const { t } = roomsCopy.useCopy();
  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  return (
    <SettingsTemplate
      title={t('pay')}
      description={t('signIn')}
      state={{ kind: 'ready' }}
      sections={
        <div className="lt-actions">
          <a className="lt-button lt-button-primary" href={loginHref}>
            {t('signInButton')}
          </a>
        </div>
      }
    />
  );
}

/** One of the settings rooms, picked by the matched address. */
export function SettingsRoom({ match }: { match: PersonalRoomMatch }) {
  const { t } = roomsCopy.useCopy();
  const { session } = useSession();
  if (!session) return <SignIn />;
  const { room, params } = match;
  const slice = room.slice;
  switch (room.id) {
    case 'contacts':
      return <ContactsRoom slice={slice} />;
    case 'group':
      return <GroupRoom kind="group" id={decodedSegment(params.groupId)} slice={slice} />;
    case 'pool':
      return <GroupRoom kind="pool" id={decodedSegment(params.poolId)} slice={slice} />;
    case 'limits':
      return (
        <FactsRoom
          title={t('limitsTitle')}
          line={t('limitsLine')}
          facts={[t('limitsTier'), t('limitsPerPayment'), t('limitsPerDay'), t('limitsUsedToday')]}
          reason={t('limitsReason')}
          slice={slice}
        />
      );
    case 'fees':
      return (
        <FactsRoom
          title={t('feesTitle')}
          line={t('feesLine')}
          facts={[t('feesSend'), t('feesRequest'), t('feesGlobal')]}
          reason={t('feesReason')}
          slice={slice}
        />
      );
    case 'preferences':
      return <PreferencesRoom slice={slice} />;
    default:
      return null;
  }
}
