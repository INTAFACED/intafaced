import { useState } from 'react';
import type { z } from 'zod';
import { Button } from '../../shared/ui';
import type { Space } from './client';
import { date, funds, NoRows, positiveMoney, ResourceView, Section, type ActionSpec, useBankRecord } from './components';
import type { sharedPotActivitySchema, sharedPotCardSchema, sharedPotsSchema } from './contracts';
import { maskedPan } from './card-controls';
import { sharedPotsCopy } from './shared-pots-copy';
import { BANK_CARDS_LIST, BANK_CARDS_SET_STATUS } from '@intafaced/contracts/bank-cards-procedures';
import {
  BANK_SHARED_POTS_LIST,
  BANK_SHARED_POTS_ACTIVITY,
  BANK_SHARED_POTS_INVITE,
  BANK_SHARED_POTS_FREEZE_CARD,
  BANK_SHARED_POTS_ACCEPT,
  BANK_SHARED_POTS_DECLINE,
  BANK_SHARED_POTS_LEAVE,
  BANK_SHARED_POTS_REMOVE,
  BANK_SHARED_POTS_CANCEL_INVITE,
  BANK_SHARED_POTS_UNLINK_CARD,
  BANK_SHARED_POTS_LINK_CARD,
} from '@intafaced/contracts/bank-shared-pots-procedures';

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
 * each with its people, its linked card and its log. Every name, amount and time is the bank's answer; the page only
 * sends the asks.
 */
export function SharedPots({ spaces, open }: { spaces: Space[]; open: (spec: ActionSpec) => void }) {
  const { t } = sharedPotsCopy.useCopy();
  const read = useBankRecord(BANK_SHARED_POTS_LIST, { limit: LIMIT });
  const pots = spaces.filter((space) => space.kind === 'named');
  // `bank` is the log's word for a change the bank's own staff made, never a person.
  const name = (person: Person) => (person.userId === 'bank' ? t('theBank') : person.handle ? `@${person.handle}` : t('someone'));
  const roleName = (role: Role) => (role === 'viewer' ? t('roleViewer') : t('roleContributor'));

  const share = () =>
    open({
      title: t('shareTitle'),
      record: BANK_SHARED_POTS_INVITE,
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
type PotCard = z.infer<typeof sharedPotCardSchema>;

/** The card linked to a pot as its people see it: its last four digits and whether it pays. */
function CardLine({ card }: { card: PotCard }) {
  const { t } = sharedPotsCopy.useCopy();
  const state = card.status === 'frozen' ? t('cardFrozen') : card.status === 'closed' ? t('cardClosed') : t('cardActive');
  return (
    <p data-testid="shared-pot-card" data-status={card.status} data-tail={card.panTail}>
      {t('cardLine', { card: maskedPan(card.panTail), state })}
    </p>
  );
}

const freezeSpec = (
  t: ReturnType<typeof sharedPotsCopy.useCopy>['t'],
  pot: { id: string; name: string },
  card: PotCard,
  note: string,
): ActionSpec => ({
  title: t('freezeTitle', { card: maskedPan(card.panTail) }),
  record: BANK_SHARED_POTS_FREEZE_CARD,
  facts: [[t('pot'), pot.name]],
  notes: [note],
  input: () => ({ spaceId: pot.id }),
  submit: t('freezeCard'),
});

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
                    record: BANK_SHARED_POTS_ACCEPT,
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
                    record: BANK_SHARED_POTS_DECLINE,
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
            <div data-testid="shared-pot-card-area">
              {row.card ? (
                <>
                  <CardLine card={row.card} />
                  {row.card.status === 'frozen' ? (
                    <p className="money-caption">
                      {row.card.frozenBy === 'operator' ? t('frozenByBank') : t('frozenNote', { owner: name(row.owner) })}
                    </p>
                  ) : (
                    row.card.status === 'active' && (
                      <Button
                        variant="secondary"
                        onClick={() => open(freezeSpec(t, row.pot, row.card!, t('freezeNote', { owner: name(row.owner) })))}
                      >
                        {t('freezeCard')}
                      </Button>
                    )
                  )}
                </>
              ) : (
                <p className="money-caption">{t('noCardShared')}</p>
              )}
            </div>
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
                    record: BANK_SHARED_POTS_LEAVE,
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
  // The person's own cards, read only when they share a pot, to offer one to link.
  const cards = useBankRecord(BANK_CARDS_LIST, { limit: LIMIT }, rows.length > 0);
  if (!rows.length) return null;
  const linkable = cards.resource.status === 'ready' ? cards.resource.data.filter((card) => card.status !== 'closed') : [];
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
                      record: BANK_SHARED_POTS_REMOVE,
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
                      record: BANK_SHARED_POTS_CANCEL_INVITE,
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
          <div data-testid="shared-pot-card-area">
            {row.card ? (
              <>
                <CardLine card={row.card} />
                <div className="actions">
                  {row.card.status === 'active' && (
                    <Button variant="secondary" onClick={() => open(freezeSpec(t, row.pot, row.card!, t('freezeOwnNote')))}>
                      {t('freezeCard')}
                    </Button>
                  )}
                  {row.card.status === 'frozen' && row.card.frozenBy === 'operator' && <p className="money-caption">{t('frozenByBank')}</p>}
                  {row.card.status === 'frozen' && row.card.frozenBy !== 'operator' && (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        open({
                          title: t('unfreezeTitle', { card: maskedPan(row.card!.panTail) }),
                          record: BANK_CARDS_SET_STATUS,
                          facts: [[t('pot'), row.pot.name]],
                          notes: [t('unfreezeNote')],
                          input: () => ({ cardId: row.card!.cardId, status: 'active' }),
                          submit: t('unfreezeCard'),
                        })
                      }
                    >
                      {t('unfreezeCard')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() =>
                      open({
                        title: t('unlinkTitle', { pot: row.pot.name }),
                        record: BANK_SHARED_POTS_UNLINK_CARD,
                        facts: [[t('cardTitle'), maskedPan(row.card!.panTail)]],
                        notes: [t('unlinkNote')],
                        input: () => ({ spaceId: row.pot.id }),
                        submit: t('unlinkCard'),
                      })
                    }
                  >
                    {t('unlinkCard')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="money-caption">{t('noCard')}</p>
                {cards.resource.status === 'ready' && linkable.length === 0 && <p className="money-caption">{t('noCards')}</p>}
                <Button
                  variant="secondary"
                  disabled={linkable.length === 0}
                  onClick={() =>
                    open({
                      title: t('linkTitle', { pot: row.pot.name }),
                      record: BANK_SHARED_POTS_LINK_CARD,
                      fields: [
                        {
                          name: 'cardId',
                          label: t('cardTitle'),
                          options: linkable.map((card) => ({ value: card.id, label: `${maskedPan(card.panTail)} (${card.assetId})` })),
                        },
                      ],
                      initial: { cardId: linkable[0]?.id ?? '' },
                      notes: [t('linkNote')],
                      input: (values) => ({ spaceId: row.pot.id, cardId: values.cardId }),
                      submit: t('linkCard'),
                    })
                  }
                >
                  {t('linkCard')}
                </Button>
              </>
            )}
          </div>
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
  const log = useBankRecord(BANK_SHARED_POTS_ACTIVITY, { spaceId, limit: LOG_SHOWN });
  const line = (entry: Entry) => {
    const words = {
      actor: name(entry.actor),
      subject: entry.subject ? name(entry.subject) : t('someone'),
      role: entry.role ? roleName(entry.role) : '',
      card: entry.card ? maskedPan(entry.card.panTail) : '',
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
