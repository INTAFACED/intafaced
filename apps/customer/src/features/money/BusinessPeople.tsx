import { useRef, useState } from 'react';
import type { z } from 'zod';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { DepthPanel, DisabledAction } from './DepthParts';
import { RecipientPicker } from './RecipientPicker';
import type { Payee } from './payees';
import { businessCopy } from './business-copy';
import {
  canSend,
  proposalMatches,
  proposalOutcome,
  recipientQuery,
  removalMatches,
  roleChangeMatches,
  ROLE_KEY,
  ROLES,
  type Role,
} from './business-model';
import { funds, positiveMoney, ResourceView, useBankRead, type ActionSpec } from './components';
import { bankReads, type businessSchema } from './contracts';
import { moneyRefusalWords, withPlainRefusal } from './money-refusal-copy';
import type { Resource } from '../../shared/resource';
import './bank-depth.css';

type Business = z.infer<typeof businessSchema>;
type OwnSpace = { id: string; name: string; assetId: string; balance: string };
/** What the customer's role on a team is: still loading, unreadable, or known. */
export type RoleState = Resource<{ role: Role }>;

/** The role the customer holds, or null while it is not known. The service has the last word either way. */
export const roleOf = (state: RoleState): Role | null => (state.status === 'ready' ? state.data.role : null);

export type FoundPerson = { handle: string; spaceId: string };

/**
 * Find a person by exact handle or email and the main account of theirs that can receive this currency.
 * Nothing is guessed: no match, no account in the currency, and every refusal from the lookup are said in words.
 */
export function PersonFinder({
  accountId,
  assetId,
  person,
  onChange,
}: {
  accountId: string;
  assetId: string;
  person: FoundPerson | null;
  onChange: (person: FoundPerson | null) => void;
}) {
  const { t } = businessCopy.useCopy();
  const { api } = useSession();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = useRef(0);
  async function find() {
    const query = recipientQuery(text);
    if (!query) {
      setProblem(t('sendQueryInvalid'));
      return;
    }
    const mine = ++run.current;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await api.query(
        'bank',
        'business.resolveRecipientSpace',
        { accountId, assetId, ...query },
        bankReads['business.resolveRecipientSpace'],
      );
      if (run.current !== mine) return;
      if (!answer.ok) {
        setProblem(moneyRefusalWords(answer.code) ?? t('sendLookupFailed'));
        return;
      }
      if (!answer.data.found) {
        setProblem(t('sendNotFound'));
        return;
      }
      if (answer.data.spaceId === null) {
        setProblem(t('sendNoAccount', { handle: answer.data.handle, asset: assetId }));
        return;
      }
      onChange({ handle: answer.data.handle, spaceId: answer.data.spaceId });
    } catch {
      if (run.current === mine) setProblem(t('sendLookupFailed'));
    } finally {
      if (run.current === mine) setBusy(false);
    }
  }
  if (person)
    return (
      <div className="bd-recipient bd-recipient--chosen">
        <span className="bd-avatar" aria-hidden="true">
          {person.handle.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <strong>{t('sendFound', { handle: person.handle, asset: assetId })}</strong>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            setText('');
            onChange(null);
          }}
        >
          {t('sendChangePerson')}
        </Button>
      </div>
    );
  return (
    <form
      className="bd-recipient__search"
      onSubmit={(event) => {
        event.preventDefault();
        void find();
      }}
    >
      <Field
        name="recipient"
        label={t('sendFindLabel')}
        value={text}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        error={problem ?? undefined}
        onChange={(event) => {
          setText(event.target.value);
          setProblem(null);
        }}
      />
      <Button type="submit" variant="secondary" disabled={busy || !text.trim()}>
        {busy ? t('sendFinding') : t('sendFind')}
      </Button>
    </form>
  );
}

type BusinessCopy = ReturnType<typeof businessCopy.forLocale>;

/** The review for paying a person found by handle or email: who gets it, how much, and what happens at the threshold. */
export function personPaymentSpec(copy: BusinessCopy, account: Business, own: readonly OwnSpace[], person: FoundPerson): ActionSpec {
  const { t } = copy;
  return {
    title: t('sendPersonTitle'),
    procedure: 'business.proposeTransfer',
    fields: [
      {
        name: 'fromSpaceId',
        label: t('sendFrom'),
        options: own.map((space) => ({ value: space.id, label: `${space.name} · ${funds(space.balance, space.assetId)}` })),
      },
      positiveMoney(account.assetId, 'amount', t('sendAmount')),
    ],
    facts: [
      [t('sendRecipientFact'), t('sendRecipientAccount', { handle: person.handle, asset: account.assetId })],
      [t('threshold'), funds(account.spendThreshold, account.assetId)],
    ],
    notes: [t('sendNote'), t('needsSecondStep')],
    // The request id is the client id, so sending the same payment again is recognised and never posted twice.
    input: (values, requestId) => ({
      accountId: account.id,
      fromSpaceId: values.fromSpaceId,
      toSpaceId: person.spaceId,
      amount: values.amount,
      clientId: requestId,
    }),
    verifyOutcome: proposalMatches,
    describeOutcome: (data, input) => {
      const outcome = proposalOutcome(data);
      if (!outcome) return null;
      return [
        [t('outcomeResult'), outcome === 'pending' ? t('outcomePending') : t('outcomePosted')],
        [t('amountLabel'), funds(String(input.amount), account.assetId)],
        [t('sendRecipientFact'), `@${person.handle}`],
      ];
    },
  };
}

/** Pay a person outside the customer's own accounts: found by handle or email, then proposed like any other payment. */
export function PayPerson({
  account,
  own,
  role,
  open,
}: {
  account: Business;
  own: readonly OwnSpace[];
  role: RoleState;
  open: (spec: ActionSpec) => void;
}) {
  const copy = businessCopy.useCopy();
  const { t } = copy;
  const [person, setPerson] = useState<FoundPerson | null>(null);
  const known = roleOf(role);
  const blocked = known !== null && !canSend(known);
  const send = () => {
    if (person) open(personPaymentSpec(copy, account, own, person));
  };
  return (
    <DepthPanel title={t('sendPersonTitle')} lead={t('sendPersonLead', { asset: account.assetId })}>
      {role.status === 'loading' ? (
        <Loading />
      ) : blocked ? (
        <DisabledAction label={t('sendMoney')} reason={t('sendRoleReason')} />
      ) : own.length === 0 ? (
        <DisabledAction label={t('sendMoney')} reason={t('sendNoSource', { asset: account.assetId })} />
      ) : (
        <>
          <PersonFinder accountId={account.id} assetId={account.assetId} person={person} onChange={setPerson} />
          <div className="actions">
            <Button onClick={send} disabled={!person}>
              {t('sendMoney')}
            </Button>
          </div>
        </>
      )}
    </DepthPanel>
  );
}

type Member = { userId: string; handle: string; role: Role };

/** The people on a team, each with their role and what that role can do. The customer is marked. */
export function TeamList({
  members,
  me,
  onChangeRole,
  onRemove,
}: {
  members: readonly Member[];
  me: string | null;
  /** Given only to an administrator. Never offered for the person themselves. */
  onChangeRole?: (member: Member) => void;
  onRemove?: (member: Member) => void;
}) {
  const { t } = businessCopy.useCopy();
  if (members.length === 0) return <p className="money-caption">{t('teamEmpty')}</p>;
  return (
    <>
      <p className="money-caption">{t('teamCount', { count: members.length })}</p>
      <ul className="bd-team">
        {members.map((member) => (
          <li key={member.userId} className="bd-team__row">
            <div>
              <strong lang="zxx" dir="ltr">
                @{member.handle}
              </strong>
              {me !== null && member.userId.toLowerCase() === me.toLowerCase() && <span className="badge">{t('teamYou')}</span>}
            </div>
            <div>
              <span className="badge">{t(ROLE_KEY[member.role])}</span>
              <small className="money-caption">
                {t(member.role === 'admin' ? 'roleAdminBody' : member.role === 'maker' ? 'roleMakerBody' : 'roleCheckerBody')}
              </small>
            </div>
            {(onChangeRole || onRemove) && !(me !== null && member.userId.toLowerCase() === me.toLowerCase()) && (
              <div className="actions" role="group" aria-label={t('memberActionsLabel', { handle: member.handle })}>
                {onChangeRole && (
                  <Button variant="secondary" onClick={() => onChangeRole(member)}>
                    {t('changeRole')}
                  </Button>
                )}
                {onRemove && (
                  <Button variant="ghost" onClick={() => onRemove(member)}>
                    {t('removeMember')}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The confirmation for giving a teammate a different role. The request id is the command id, so a resend applies once. */
export function changeRoleSpec(copy: BusinessCopy, account: Business, member: Member): ActionSpec {
  const { t } = copy;
  return {
    title: t('changeRoleTitle', { handle: member.handle }),
    procedure: 'business.setMemberRole',
    fields: [
      {
        name: 'role',
        label: t('addMemberRole'),
        options: ROLES.map((each) => ({
          value: each,
          label: each === 'admin' ? t('addMemberRoleAdmin') : each === 'maker' ? t('addMemberRoleMaker') : t('addMemberRoleChecker'),
        })),
      },
    ],
    facts: [
      [t('membersTitle'), `@${member.handle}`],
      [t('roleCurrent'), t(ROLE_KEY[member.role])],
    ],
    notes: [t('changeRoleNote'), t('needsSecondStep')],
    submit: t('changeRoleSubmit'),
    validate: (input) => (input.role === member.role ? t('changeRoleSame') : null),
    input: (values, requestId) => ({ accountId: account.id, userId: member.userId, role: values.role as Role, requestId }),
    verifyOutcome: roleChangeMatches,
  };
}

/** The confirmation for removing a teammate. The bank refuses the last administrator and anyone with a payment waiting. */
export function removeMemberSpec(copy: BusinessCopy, account: Business, member: Member): ActionSpec {
  const { t } = copy;
  return {
    title: t('removeMemberTitle', { handle: member.handle }),
    procedure: 'business.removeMember',
    facts: [
      [t('membersTitle'), `@${member.handle}`],
      [t('roleCurrent'), t(ROLE_KEY[member.role])],
    ],
    notes: [t('removeMemberNote'), t('needsSecondStep')],
    submit: t('removeMemberSubmit'),
    input: (_values, requestId) => ({ accountId: account.id, userId: member.userId, requestId }),
    verifyOutcome: removalMatches,
  };
}

/** Everyone on the team and what they can do, read from the bank; adding a teammate sits beneath. */
export function TeamPanel({ account, role, open }: { account: Business; role: RoleState; open: (spec: ActionSpec) => void }) {
  const copy = businessCopy.useCopy();
  const { t } = copy;
  const { userId } = useSession();
  const team = useBankRead('business.members', { accountId: account.id });
  const [person, setPerson] = useState<Payee | null>(null);
  const known = roleOf(role);
  const add = () => {
    if (!person) return;
    open({
      title: t('addMemberTitle', { name: account.name }),
      procedure: 'business.addMember',
      fields: [
        {
          name: 'role',
          label: t('addMemberRole'),
          options: ROLES.map((each) => ({
            value: each,
            label: each === 'admin' ? t('addMemberRoleAdmin') : each === 'maker' ? t('addMemberRoleMaker') : t('addMemberRoleChecker'),
          })),
        },
      ],
      facts: [[t('membersTitle'), `@${person.handle}`]],
      notes: [t('needsSecondStep')],
      submit: t('addMemberSubmit'),
      input: (values) => ({ accountId: account.id, userId: person.userId, role: values.role as Role }),
      verifyOutcome: (data, input) =>
        !!data &&
        typeof data === 'object' &&
        (data as Record<string, unknown>).accountId === input.accountId &&
        (data as Record<string, unknown>).userId === input.userId &&
        (data as Record<string, unknown>).role === input.role,
    });
  };
  return (
    <DepthPanel title={t('membersTitle')} lead={t('teamLead')}>
      {team.resource.status === 'failed' ? (
        <Failure result={withPlainRefusal(team.resource.failure)} retry={team.reload} />
      ) : (
        <ResourceView resource={team.resource} reload={team.reload}>
          {({ members }) => (
            <TeamList
              members={members}
              me={userId ?? null}
              {...(known === 'admin'
                ? {
                    onChangeRole: (member: Member) => open(changeRoleSpec(copy, account, member)),
                    onRemove: (member: Member) => open(removeMemberSpec(copy, account, member)),
                  }
                : {})}
            />
          )}
        </ResourceView>
      )}
      <h4 className="bd-subhead">{t('addMember')}</h4>
      {known !== null && known !== 'admin' ? (
        <DisabledAction label={t('addMember')} reason={t('addMemberAdminOnly')} />
      ) : (
        <>
          <p className="money-caption">{t('addMemberChoose')}</p>
          <RecipientPicker value={person} onChange={setPerson} />
          <div className="actions">
            <Button disabled={!person} onClick={add}>
              {t('addMember')}
            </Button>
          </div>
        </>
      )}
    </DepthPanel>
  );
}
