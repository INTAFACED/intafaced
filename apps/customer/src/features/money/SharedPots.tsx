import { useState } from 'react';
import type { z } from 'zod';
import { Button } from '../../shared/ui';
import type { Space } from './client';
import { date, funds, NoRows, positiveMoney, ResourceView, Section, useBankRead, type ActionSpec } from './components';
import type { sharedPotActivitySchema, sharedPotsSchema } from './contracts';
import { sharedPotsCopy } from './shared-pots-copy';

type SharedPots = z.infer<typeof sharedPotsSchema>;
type Person = { userId: string; handle: string | null };
type Role = 'contributor' | 'viewer';
const LIMIT = 50;
const LOG_SHOWN = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE = /^@?[a-zA-Z0-9_]{3,32}$/;

/**
 * Shared pots on the Spaces page (BK-acct-09, J-bank-07 #6): the bank's two values, a door to share one of the
 * person's pots by handle or email, invites to them with their lifetime, pots shared with them and pots they share,
 * each with its people and its log. Every name, amount and time is the bank's answer; the page only sends the asks.
 */
export function SharedPots({ spaces, open }: { spaces: Space[]; open: (spec: ActionSpec) => void }) {
  const { t } = sharedPotsCopy.useCopy();
  const read = useBankRead('sharedPots.list', { limit: LIMIT });
  const pots = spaces.filter((space) => space.kind === 'named');
  const name = (person: Person) => (person.handle ? `@${person.handle}` : t('someone'));
  const roleName = (role: Role) => (role === 'viewer' ? t('roleViewer') : t('roleContributor'));

  const share = () =>
    open({
      title: t('shareTitle'),
      procedure: 'sharedPots.invite',
      fields: [
        {
          name: 'spaceId',
          label: t('pot'),
          options: pots.map((pot) => ({ value: pot.id, label: `${pot.name} (${pot.assetId})` })),
        },
        {
          name: 'who',
          label: t('who'),
          hint: t('whoHint'),
          validate: (value) => (EMAIL.test(value.trim()) || HANDLE.test(value.trim()) ? null : t('whoInvalid')),
        },
        {
          name: 'role',
          label: t('role'),
          options: [
            { value: 'viewer', label: t('viewer') },
            { value: 'contributor', label: t('contributor') },
          ],
        },
      ],
      initial: { spaceId: pots[0]?.id ?? '', role: 'viewer' },
      notes: [t('shareNote')],
      input: (values, requestId) => {
        const who = values.who!.trim();
        return { inviteId: requestId, spaceId: values.spaceId, role: values.role, ...(EMAIL.test(who) ? { email: who } : { handle: who }) };
      },
      submit: t('shareSubmit'),
    });

  return (
    <div data-testid="shared-pots">
      <Section
        title={t('title')}
        description={t('description')}
        actions={
          <Button onClick={share} disabled={pots.length === 0} aria-describedby={pots.length === 0 ? 'shared-pots-why' : undefined}>
            {t('share')}
          </Button>
        }
      >
        {pots.length === 0 && (
          <p id="shared-pots-why" className="money-caption">
            {t('noPots')}
          </p>
        )}
        <ResourceView resource={read.resource} reload={read.reload}>
          {(data) => (
            <>
              <Terms terms={data.terms} />
              <Invites invites={data.invites} open={open} name={name} roleName={roleName} />
              <SharedWithMe rows={data.shared} spaces={spaces} open={open} name={name} roleName={roleName} />
              <IShare rows={data.owned} open={open} name={name} roleName={roleName} />
            </>
          )}
        </ResourceView>
      </Section>
    </div>
  );
}

type Named = { name: (person: Person) => string; roleName: (role: Role) => string };

function Terms({ terms }: { terms: SharedPots['terms'] }) {
  const { t } = sharedPotsCopy.useCopy();
  return terms.inviteMinutes === null || terms.peopleCap === null ? (
    <p className="money-caption" data-testid="shared-pots-terms" data-state="unset">
      {t('termsUnset')}
    </p>
  ) : (
    <p
      className="money-caption"
      data-testid="shared-pots-terms"
      data-state="set"
      data-minutes={terms.inviteMinutes}
      data-cap={terms.peopleCap}
    >
      {t('terms', { minutes: terms.inviteMinutes, cap: terms.peopleCap })}
    </p>
  );
}

function Invites({ invites, open, name, roleName }: { invites: SharedPots['invites']; open: (spec: ActionSpec) => void } & Named) {
  const { t } = sharedPotsCopy.useCopy();
  if (!invites.length) return null;
  return (
    <section aria-label={t('invitesTitle')}>
      <h3>{t('invitesTitle')}</h3>
      <ul className="money-list">
        {invites.map((invite) => (
          <li key={invite.inviteId} data-testid="shared-pot-invite" data-invite={invite.inviteId} data-expired={invite.expired}>
            <p>
              {t('invite', { owner: name(invite.owner), pot: invite.pot.name, asset: invite.pot.assetId, role: roleName(invite.role) })}{' '}
              {invite.expired ? t('endedAt', { time: date(invite.expiresAt) }) : t('openUntil', { time: date(invite.expiresAt) })}
            </p>
            <div className="actions">
              <Button
                variant="secondary"
                onClick={() =>
                  open({
                    title: t('acceptTitle', { pot: invite.pot.name }),
                    procedure: 'sharedPots.accept',
                    facts: [
                      [t('owner'), name(invite.owner)],
                      [t('yourRole'), roleName(invite.role)],
                    ],
                    notes: [t('acceptNote', { role: roleName(invite.role) })],
                    verifyOutcome: (data) => (data as { spaceId: string }).spaceId === invite.spaceId,
                    input: () => ({ inviteId: invite.inviteId }),
                    submit: t('accept'),
                  })
                }
              >
                {t('accept')}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  open({
                    title: t('declineTitle', { pot: invite.pot.name }),
                    procedure: 'sharedPots.decline',
                    facts: [[t('owner'), name(invite.owner)]],
                    notes: [],
                    input: () => ({ inviteId: invite.inviteId }),
                    submit: t('decline'),
                  })
                }
              >
                {t('decline')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SharedWithMe({
  rows,
  spaces,
  open,
  name,
  roleName,
}: { rows: SharedPots['shared']; spaces: Space[]; open: (spec: ActionSpec) => void } & Named) {
  const { t } = sharedPotsCopy.useCopy();
  if (!rows.length) return null;
  return (
    <section aria-label={t('sharedTitle')}>
      <h3>{t('sharedTitle')}</h3>
      {rows.map((row) => {
        const account = spaces.find((space) => space.kind === 'primary' && space.assetId === row.pot.assetId);
        const add = () =>
          account &&
          open({
            title: t('addTitle', { pot: row.pot.name }),
            procedure: 'transfers.create',
            unit: row.pot.assetId,
            fields: [positiveMoney(row.pot.assetId)],
            facts: [
              [t('owner'), name(row.owner)],
              [t('yourRole'), roleName(row.role)],
            ],
            notes: [t('addNote', { owner: name(row.owner) })],
            input: (values, requestId) => ({
              transferId: requestId,
              fromSpaceId: account.id,
              toSpaceId: row.pot.id,
              amount: values.amount,
            }),
            submit: t('addMoney'),
          });
        return (
          <article className="money-record" key={row.pot.id} data-testid="shared-pot-shared" data-pot={row.pot.id} data-role={row.role}>
            <header>
              <div>
                <h4 lang="und" dir="auto">
                  {row.pot.name}
                </h4>
                <p className="money-caption">
                  {t('owner')}: {name(row.owner)} · {t('yourRole')}: {roleName(row.role)}
                </p>
              </div>
              <strong className="numeric" data-testid="shared-pot-balance" data-amount={row.pot.balance}>
                {funds(row.pot.balance, row.pot.assetId)}
              </strong>
            </header>
            <People members={row.members} name={name} roleName={roleName} />
            {!account && <p className="money-caption">{t('noAccount', { asset: row.pot.assetId })}</p>}
            <div className="actions">
              <Button variant="secondary" onClick={add} disabled={!account}>
                {t('addMoney')}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  open({
                    title: t('leaveTitle', { pot: row.pot.name }),
                    procedure: 'sharedPots.leave',
                    facts: [[t('owner'), name(row.owner)]],
                    notes: [t('leaveNote')],
                    input: () => ({ spaceId: row.pot.id }),
                    submit: t('leave'),
                  })
                }
              >
                {t('leave')}
              </Button>
            </div>
            <Log spaceId={row.pot.id} name={name} roleName={roleName} />
          </article>
        );
      })}
    </section>
  );
}

function IShare({ rows, open, name, roleName }: { rows: SharedPots['owned']; open: (spec: ActionSpec) => void } & Named) {
  const { t } = sharedPotsCopy.useCopy();
  if (!rows.length) return null;
  return (
    <section aria-label={t('ownedTitle')}>
      <h3>{t('ownedTitle')}</h3>
      {rows.map((row) => (
        <article className="money-record" key={row.pot.id} data-testid="shared-pot-owned" data-pot={row.pot.id}>
          <h4 lang="und" dir="auto">
            {row.pot.name}
          </h4>
          <ul className="money-list">
            {row.members.map((member) => (
              <li key={member.userId} data-testid="shared-pot-member" data-role={member.role}>
                {t('member', { person: name(member), role: roleName(member.role) })}{' '}
                <Button
                  variant="ghost"
                  onClick={() =>
                    open({
                      title: t('removeTitle', { pot: row.pot.name, person: name(member) }),
                      procedure: 'sharedPots.remove',
                      notes: [t('removeNote')],
                      input: () => ({ spaceId: row.pot.id, userId: member.userId }),
                      submit: t('remove'),
                    })
                  }
                >
                  {t('remove')}
                </Button>
              </li>
            ))}
            {row.invites.map((invite) => (
              <li key={invite.inviteId} data-testid="shared-pot-open-invite" data-expired={invite.expired}>
                {t(invite.expired ? 'expiredInvite' : 'openInvite', {
                  person: name(invite.invitee),
                  role: roleName(invite.role),
                  time: date(invite.expiresAt),
                })}{' '}
                <Button
                  variant="ghost"
                  onClick={() =>
                    open({
                      title: t('cancelTitle', { person: name(invite.invitee) }),
                      procedure: 'sharedPots.cancelInvite',
                      facts: [[t('pot'), row.pot.name]],
                      notes: [t('cancelNote')],
                      input: () => ({ inviteId: invite.inviteId }),
                      submit: t('cancel'),
                    })
                  }
                >
                  {t('cancel')}
                </Button>
              </li>
            ))}
          </ul>
          <Log spaceId={row.pot.id} name={name} roleName={roleName} />
        </article>
      ))}
    </section>
  );
}

function People({ members, name, roleName }: { members: SharedPots['shared'][number]['members'] } & Named) {
  const { t } = sharedPotsCopy.useCopy();
  return (
    <p className="money-caption">
      {t('people')}: {members.map((member) => t('member', { person: name(member), role: roleName(member.role) })).join('; ')}
    </p>
  );
}

type Entry = z.infer<typeof sharedPotActivitySchema>;

/** The pot's log, read from the bank only once the person opens it. */
function Log({ spaceId, name, roleName }: { spaceId: string } & Named) {
  const { t } = sharedPotsCopy.useCopy();
  const [opened, setOpened] = useState(false);
  return (
    <details data-testid="shared-pot-log" onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>{t('log')}</summary>
      {opened && <LogEntries spaceId={spaceId} name={name} roleName={roleName} />}
    </details>
  );
}

function LogEntries({ spaceId, name, roleName }: { spaceId: string } & Named) {
  const { t } = sharedPotsCopy.useCopy();
  const log = useBankRead('sharedPots.activity', { spaceId, limit: LOG_SHOWN });
  const line = (entry: Entry) => {
    const words = {
      actor: name(entry.actor),
      subject: entry.subject ? name(entry.subject) : t('someone'),
      role: entry.role ? roleName(entry.role) : '',
    };
    return t('at', { line: t(entry.kind, words), time: date(entry.at) });
  };
  return (
    <ResourceView resource={log.resource} reload={log.reload}>
      {(entries) =>
        entries.length ? (
          <ul className="money-list">
            {entries.map((entry) => (
              <li key={entry.id} data-testid="shared-pot-log-entry" data-kind={entry.kind}>
                {line(entry)}
              </li>
            ))}
          </ul>
        ) : (
          <NoRows title={t('noLog')} />
        )
      }
    </ResourceView>
  );
}
