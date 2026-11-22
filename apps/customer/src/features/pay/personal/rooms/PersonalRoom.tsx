import { useMemo, type ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import { useSession } from '../../../session';
import { contactLabel, contactsFrom, readSent, requestPath } from '../personal-model';
import { decodedSegment, type PersonalRoomMatch } from './rooms';
import { roomsCopy } from './rooms-copy';
import { isPersonalFlowRoom, PersonalFlowRoom } from '../../../../screens/pay/PersonalFlowRooms';
import { PersonalRecordRoom } from '../../../../screens/pay/PersonalRecordRooms';

/** The room's layout: headline on the left, one card on the right, the way Send and Receive sit. */
function Frame({ title, line, children }: { title: string; line: string; children: ReactNode }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div className="if-pay" data-testid="pay-room">
      <div className="pay-grid">
        <header data-testid="pay-hero" className="pay-hero">
          <h1>{title}</h1>
          <p>{line}</p>
        </header>
        <section data-testid="pay-card" className="pay-card" aria-label={title}>
          <div className="pay-body">
            {children}
            <a className="pay-recent__link" href="/pay" data-testid="pay-room-back">
              {t('back')}
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Why a room has nothing behind it yet, always on screen. `slice` is the work that connects it. */
function Blocked({ slice, children }: { slice: string; children: ReactNode }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div className="pay-reason" id="pay-room-reason" role="note" data-testid="pay-reason" data-slice={slice}>
      <p className="pay-reason__title">{t('blockedTitle')}</p>
      <p className="pay-reason__body">{children}</p>
    </div>
  );
}

/** Rows of a fact and its value. A value that is not known says so; it is never filled in. */
function Rows({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="pay-quote">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A control that cannot run yet: visible, off, and tied to the reason on screen. */
function Off({ children, describedBy }: { children: ReactNode; describedBy: string }) {
  return (
    <Button type="button" variant="secondary" size={40} disabled aria-describedby={describedBy}>
      {children}
    </Button>
  );
}

function Section({ title, empty, off, describedBy }: { title: string; empty: string; off: string; describedBy: string }) {
  return (
    <div className="pay-block">
      <h3 className="pay-section-title">{title}</h3>
      <p className="pay-empty">{empty}</p>
      <Off describedBy={describedBy}>{off}</Off>
    </div>
  );
}

function ContactsRoom({ slice }: { slice: string }) {
  const copy = roomsCopy.useCopy();
  const { t } = copy;
  const { userId } = useSession();
  const people = useMemo(() => (userId ? contactsFrom(readSent(userId), 50) : []), [userId]);
  return (
    <Frame title={t('contactsTitle')} line={t('contactsLine')}>
      <div className="pay-block" data-testid="contacts-device">
        <h3 className="pay-section-title">{t('contactsRecentTitle')}</h3>
        {people.length === 0 ? (
          <p className="pay-empty">{t('contactsRecentEmpty')}</p>
        ) : (
          <ul className="pay-list">
            {people.map((person) => (
              <li key={person.userId} data-testid="contact-row">
                <div className="pay-list__main">
                  <span>{contactLabel(person)}</span>
                  <span className="pay-list__sub">{copy.t('contactsTimes', { count: String(person.times) })}</span>
                </div>
                <div className="pay-row-actions">
                  <Button
                    variant="secondary"
                    size={32}
                    nativeButton={false}
                    render={<a href={requestPath({ to: person.handle ?? person.userId })} />}
                  >
                    {t('contactsPay')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Section title={t('contactsSaved')} empty={t('contactsSavedEmpty')} off={t('contactsAdd')} describedBy="pay-room-reason" />
      <Section title={t('contactsGroups')} empty={t('contactsGroupsEmpty')} off={t('contactsNewGroup')} describedBy="pay-room-reason" />
      <Section title={t('contactsPools')} empty={t('contactsPoolsEmpty')} off={t('contactsNewPool')} describedBy="pay-room-reason" />
      <Blocked slice={slice}>{t('contactsReason')}</Blocked>
    </Frame>
  );
}

function GroupRoom({ kind, id, slice }: { kind: 'group' | 'pool'; id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  const pool = kind === 'pool';
  const rows: Array<readonly [string, string]> = [[t('reference'), id ?? t('notSet')]];
  if (pool) rows.push([t('poolAmount'), t('notSet')], [t('poolPaid'), t('notSet')]);
  return (
    <Frame title={t(pool ? 'poolTitle' : 'groupTitle')} line={t(pool ? 'poolLine' : 'groupLine')}>
      <Rows rows={rows} />
      <Section title={t('members')} empty={t('membersEmpty')} off={t('addMember')} describedBy="pay-room-reason" />
      <Blocked slice={slice}>{t('groupReason')}</Blocked>
    </Frame>
  );
}

function FactsRoom({ title, line, facts, reason, slice }: { title: string; line: string; facts: string[]; reason: string; slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={title} line={line}>
      <Rows rows={facts.map((fact): readonly [string, string] => [fact, t('notSet')])} />
      <Blocked slice={slice}>{reason}</Blocked>
    </Frame>
  );
}

function PreferencesRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={t('preferencesTitle')} line={t('preferencesLine')}>
      <form className="pay-body" noValidate onSubmit={(event) => event.preventDefault()}>
        <fieldset className="pay-fieldset" disabled aria-describedby="pay-room-reason">
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="pay-pref-source">
              {t('prefSource')}
            </label>
            <select id="pay-pref-source" className="pay-text" defaultValue="">
              <option value="">{t('notSet')}</option>
            </select>
            <p className="pay-hint">{t('prefSourceHint')}</p>
          </div>
          <label className="pay-field__label">
            <input type="checkbox" /> {t('prefFind')}
          </label>
          <label className="pay-field__label">
            <input type="checkbox" /> {t('prefReceipts')}
          </label>
        </fieldset>
      </form>
      <Blocked slice={slice}>{t('preferencesReason')}</Blocked>
    </Frame>
  );
}

/** One personal Pay room, picked by the matched address. A signed-out visitor is sent to sign in and nothing is read. */
export function PersonalRoom({ match }: { match: PersonalRoomMatch }) {
  const { t } = roomsCopy.useCopy();
  const { session } = useSession();
  // Scan, a request, a claim and a payment link are drawn on the flow template, signed out included.
  if (isPersonalFlowRoom(match.room.id)) return <PersonalFlowRoom match={match} />;
  if (!session) {
    const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
    return (
      <Frame title={t('pay')} line={t('signIn')}>
        <Button variant="primary" size={56} fullWidth nativeButton={false} render={<a href={loginHref} role="link" />}>
          {t('signInButton')}
        </Button>
      </Frame>
    );
  }
  return <RoomBody match={match} />;
}

function RoomBody({ match }: { match: PersonalRoomMatch }) {
  const { t } = roomsCopy.useCopy();
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
    case 'request':
    case 'claim':
    case 'scan':
    case 'link':
      return <PersonalFlowRoom match={match} />;
    case 'scheduled':
    case 'payment':
    case 'cases':
    case 'case':
    case 'invoice':
      return <PersonalRecordRoom match={match} />;
  }
}
