import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import { EmptyState, Field, Page } from './ui-kit';
import { navigate } from '../../app/location';
import { useSession } from '../session/session';
import { contactLabel, contactsFrom, parseRequestLink, readRequests, readSent, requestPath } from './personal/personal-model';
import { matchPersonalRoute, type PersonalMatch, type PersonalTitle } from './personal-room-routes';
import { personalRoomsCopy, type PersonalRoomsKey as Key } from './personal-rooms-copy';

const DESCRIPTION: Record<PersonalTitle, Key> = {
  request: 'descRequest',
  scheduled: 'descScheduled',
  contacts: 'descContacts',
  transfer: 'descTransfer',
  claim: 'descClaim',
  cases: 'descCases',
  case: 'descCase',
  limits: 'descLimits',
  fees: 'descFees',
  preferences: 'descPreferences',
  scan: 'descScan',
  link: 'descLink',
  invoice: 'descInvoice',
  group: 'descGroup',
  pool: 'descPool',
};
/** The one missing source each refusal page names. */
const BLOCKER: Partial<Record<PersonalTitle, Key>> = {
  scheduled: 'blockedScheduled',
  claim: 'blockedClaim',
  cases: 'blockedCases',
  case: 'blockedCase',
  limits: 'blockedLimits',
  fees: 'blockedFees',
  preferences: 'blockedPreferences',
  link: 'blockedLink',
  invoice: 'blockedInvoice',
  group: 'blockedGroup',
  pool: 'blockedPool',
};

/** Personal Pay addresses beyond the five tabs (PP-order-02). Pages with no data source refuse in words and send no request. */
export function PersonalRooms({ path }: { path: string }) {
  const { languageFor } = personalRoomsCopy.useCopy();
  const match = matchPersonalRoute(path.split('?')[0] ?? path);
  return (
    <div lang={languageFor('eyebrow')} data-personal-room={match?.route.title}>
      {match ? <Room match={match} /> : null}
    </div>
  );
}

function Room({ match }: { match: PersonalMatch }) {
  const { t } = personalRoomsCopy.useCopy();
  const { userId } = useSession();
  const { route } = match;
  const back = (
    <a className="text-link" href={route.parent}>
      {t('openParent')}
    </a>
  );
  let content: ReactNode;
  if (match.invalid) {
    content = (
      <section aria-label={t('badIdTitle')}>
        <EmptyState title={t('badIdTitle')} action={back}>
          {t('badIdBody')}
        </EmptyState>
      </section>
    );
  } else if (route.kind === 'contacts') content = <Contacts userId={userId} back={back} />;
  else if (route.kind === 'request') content = <RequestRecord userId={userId} id={match.id ?? ''} back={back} />;
  else if (route.kind === 'transfer') content = <TransferRecord userId={userId} id={match.id ?? ''} back={back} />;
  else if (route.kind === 'scan') content = <Scan back={back} />;
  else {
    const reason = BLOCKER[route.title];
    content = (
      <section aria-label={t(route.title)}>
        <EmptyState title={t('noSourceTitle')} action={back}>
          {reason ? t(reason) : null}
        </EmptyState>
      </section>
    );
  }
  return (
    <Page eyebrow={t('eyebrow')} title={t(route.title)} description={t(DESCRIPTION[route.title])}>
      {content}
    </Page>
  );
}

function Contacts({ userId, back }: { userId: string | null; back: ReactNode }) {
  const { t } = personalRoomsCopy.useCopy();
  const contacts = useMemo(() => (userId ? contactsFrom(readSent(userId), 200) : []), [userId]);
  return (
    <section aria-label={t('contacts')}>
      <p className="muted">{t('deviceNote')}</p>
      {contacts.length === 0 ? (
        <EmptyState title={t('noContactsTitle')} action={back}>
          {t('noContactsBody')}
        </EmptyState>
      ) : (
        <ul className="plain-list">
          {contacts.map((contact) => (
            <li key={contact.userId}>
              <strong>{contactLabel(contact)}</strong> · {t('times')}: {contact.times} · {t('lastPaid')}: {contact.lastAt}{' '}
              <a className="text-link" href={requestPath({ to: contact.handle ?? contact.userId })}>
                {t('payAgain')}
              </a>
            </li>
          ))}
        </ul>
      )}
      {contacts.length > 0 ? back : null}
    </section>
  );
}

function Rows({ rows }: { rows: ReadonlyArray<readonly [string, string | null]> }) {
  return (
    <dl className="kv">
      {rows
        .filter((row): row is readonly [string, string] => row[1] !== null)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function RequestRecord({ userId, id, back }: { userId: string | null; id: string; back: ReactNode }) {
  const { t } = personalRoomsCopy.useCopy();
  const entry = useMemo(() => (userId ? (readRequests(userId).find((row) => row.id === id) ?? null) : null), [userId, id]);
  if (!entry)
    return (
      <section aria-label={t('noRequestTitle')}>
        <EmptyState title={t('noRequestTitle')} action={back}>
          {t('noRequestBody')}
        </EmptyState>
      </section>
    );
  return (
    <section aria-label={t('request')}>
      <p className="muted">{t('deviceNote')}</p>
      <Rows
        rows={[
          [t('amount'), entry.amount && entry.asset ? `${entry.amount} ${entry.asset}` : null],
          [t('to'), entry.to],
          [t('note'), entry.note],
          [t('createdOn'), entry.at],
        ]}
      />
      <a className="text-link" href={entry.path}>
        {t('openRequest')}
      </a>{' '}
      {back}
    </section>
  );
}

function TransferRecord({ userId, id, back }: { userId: string | null; id: string; back: ReactNode }) {
  const { t } = personalRoomsCopy.useCopy();
  const entry = useMemo(() => (userId ? (readSent(userId).find((row) => row.transferId === id) ?? null) : null), [userId, id]);
  if (!entry)
    return (
      <section aria-label={t('noTransferTitle')}>
        <EmptyState title={t('noTransferTitle')} action={back}>
          {t('noTransferBody')}
        </EmptyState>
      </section>
    );
  return (
    <section aria-label={t('transfer')}>
      <p className="muted">{t('deviceNote')}</p>
      <Rows
        rows={[
          [t('amount'), `${entry.amount} ${entry.asset}`],
          [t('to'), entry.handle ? `@${entry.handle}` : entry.toUserId],
          [t('when'), entry.at],
          [t('reference'), entry.ledgerTxId],
          [t('note'), entry.note],
        ]}
      />
      {back}
    </section>
  );
}

function Scan({ back }: { back: ReactNode }) {
  const { t } = personalRoomsCopy.useCopy();
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  return (
    <section aria-label={t('scan')}>
      <p className="muted">{t('scanIntro')}</p>
      <p className="muted">{t('scanCamera')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseRequestLink(text, location.origin);
          if (!parsed) {
            setBad(true);
            return;
          }
          navigate(requestPath(parsed));
        }}
      >
        <Field
          label={t('scanLabel')}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setBad(false);
          }}
          error={bad ? t('scanBad') : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" variant="primary">
          {t('scanOpen')}
        </Button>
      </form>
      {back}
    </section>
  );
}
