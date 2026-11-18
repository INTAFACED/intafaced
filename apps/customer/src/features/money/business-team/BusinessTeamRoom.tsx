import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { z, type ZodType } from 'zod';
import { Button } from '@intafaced/ui';
import { FlowTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import {
  BUSINESS_PAYMENT_TYPES,
  BUSINESS_TEAM_PERMISSIONS,
  businessTeamAdvisorSchema,
  businessTeamDepartmentSchema,
  businessTeamInviteMadeSchema,
  businessTeamInviteSchema,
  businessTeamJoinedSchema,
  businessTeamMemberSchema,
  businessTeamOverviewSchema,
  businessTeamPaymentSchema,
  businessTeamRoleSchema,
  businessTeamRuleSchema,
  businessTeamSpendSchema,
  type BusinessTeamMember,
  type BusinessTeamOverview,
  type BusinessTeamPayment,
  type BusinessTeamPermission,
  type BusinessTeamRule,
} from '@intafaced/contracts/bank-business-team';
import { defineCopy } from '../../../shared/i18n';
import type { ApiResult } from '../../../shared/api';
import { useResource, type Resource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { useHeldId, type HeldId } from './held-id';

/**
 * A business bank team and its approval rules (J-bank-19; BK-biz-01 to BK-biz-04), on the flow template.
 *
 * `/bank/business/team`: in Business mode, the business picked in the account menu: its roles, members, advisors,
 * invites, approval rules and payments. `/bank/business/spend`: team spend by member and departments.
 * `/bank/business/payment?id=`: one payment's approval page. `/bank/business/join#<secret>`: an invite opened.
 *
 * The business's money is the partner bank's. A payment is one instruction to the partner, sent once when the last
 * approval its rule asks for is given; nothing is posted to INTAFACED's own books. Every check is the bank's: this page
 * shows the permissions it reports and the refusals it gives, by name.
 */
const copy = defineCopy('money.business-team', {
  title: 'Team and approvals',
  description: 'Roles, invites, approval rules and payments for your business',
  spendTitle: 'Team spend',
  spendDescription: 'What each member’s payments took out, as the partner bank reports it, and departments',
  paymentTitle: 'Payment approval',
  paymentDescription: 'The rule that applied, each approval and the result',
  joinTitle: 'Join a business',
  joinDescription: 'Accept an invitation to a business bank team',
  personalTitle: 'Choose a business',
  personalBody: 'You are in your personal profile. Pick a business in the account menu to see its team.',
  signedOutTitle: 'Sign in to continue',
  signedOutBody: 'A business team belongs to its members.',
  signIn: 'Sign in',
  readFailedTitle: 'This could not be read',
  refusedTitle: 'It was not done',
  yourRole: 'Your role',
  owner: 'Owner',
  balance: 'Balance at {label}',
  balanceNotKnown: 'Not known: {label} has not reported it',
  balanceNone: 'This business’s money is not held at a partner bank.',
  asOf: 'as of',
  can: 'Can',
  perm_view: 'view',
  perm_export: 'export',
  perm_propose: 'propose payments',
  perm_approve: 'approve payments',
  perm_manage_team: 'manage the team',
  perm_team_spend: 'see team spend',
  rolesTitle: 'Roles',
  rolesEmpty: 'No roles of your own yet. Members hold their built-in role.',
  roleName: 'Role name',
  createRole: 'Create role',
  roleCreated: 'Role {name} created.',
  membersTitle: 'Members',
  advisor: 'Advisor',
  roleFor: 'Role for {handle}',
  builtIn: 'Built-in role',
  changeRole: 'Change role',
  roleChanged: 'Role changed.',
  advisorsTitle: 'Advisors',
  advisorsBody: 'An advisor sees the business and nothing more. Their access needs the owner’s approval.',
  advisorsEmpty: 'No advisors.',
  advisorHandle: 'Advisor’s handle',
  addAdvisor: 'Add advisor',
  advisorWaiting: 'Waiting for the owner’s approval',
  advisorApproved: 'Approved',
  approveAdvisor: 'Approve',
  addedBy: 'added by @{handle}',
  invitesTitle: 'Invites',
  invitesLifetime: 'An invite lasts {n} minutes.',
  invitesLifetimeNotSet: 'How long an invite lasts is not set, so no invite can be sent yet.',
  inviteEmail: 'Email (leave blank to invite by link)',
  inviteRole: 'Role',
  sendInvite: 'Send invite',
  inviteLink: 'Invite link',
  inviteLinkEmail: 'Email delivery is not connected. Send this link to {email} yourself; only that account can use it.',
  inviteLinkOnly: 'Send this link to the person you invite. Anyone signed in with it can join.',
  invitesEmpty: 'No invites.',
  inviteTo: 'To {email}',
  inviteByLink: 'By link',
  status_open: 'Open',
  status_expired: 'Expired',
  status_accepted: 'Accepted',
  status_revoked: 'Revoked',
  status_replaced: 'Sent again',
  until: 'until',
  resend: 'Send again',
  revoke: 'Revoke',
  rulesTitle: 'Approval rules',
  rulesBody: 'A payment over the amount needs that many approvers, none of them the person who proposed it.',
  rulesEmpty: 'No rules: every payment is sent at once.',
  ruleOver: 'Over',
  rulePayee: 'Payee (leave blank for any)',
  ruleType: 'Payment type',
  ruleApprovals: 'Approvers needed',
  anyPayee: 'any payee',
  anyType: 'any type',
  saveRule: 'Save rule',
  ruleSaved: 'Rule saved.',
  ruleLine: 'Over {amount} {asset}, {payee}, {type}: {n} approvers',
  type_domestic: 'domestic',
  type_international: 'international',
  type_payroll: 'payroll',
  paymentsTitle: 'Payments',
  paymentsEmpty: 'No payments yet.',
  payee: 'Payee',
  amount: 'Amount',
  propose: 'Propose payment',
  proposed: 'Payment proposed.',
  open: 'Open',
  pay_pending: 'Waiting for {left} more approval(s)',
  pay_sending: 'Sending to the partner bank: its answer is not known yet',
  pay_sent: 'Sent to {label}',
  pay_refused: 'Refused by the partner bank: nothing moved',
  pay_rejected: 'Declined: nothing was sent',
  ruleApplied: 'Rule that applied',
  noRule: 'No rule applied: sent at once.',
  approvalsTitle: 'Approvals',
  approvalsNone: 'No approvals yet.',
  approvedBy: '@{handle} approved',
  result: 'Result',
  partnerRef: 'Partner reference',
  proposedBy: 'Proposed by @{handle}',
  approve: 'Approve',
  decline: 'Decline',
  tryAgain: 'Try sending again',
  approved: 'Approval recorded.',
  spendScopeSelf: 'Your role does not include team spend, so you see only your own payments.',
  spendMember: 'Member',
  spendPartner: 'Partner lines',
  spendRecord: 'Our record',
  spendLines: '{n} lines',
  departmentsTitle: 'Departments',
  departmentsEmpty: 'No departments.',
  departmentName: 'Department name',
  departmentBudget: 'Budget (leave blank for none)',
  addDepartment: 'Add department',
  budgetNotSet: 'No budget set',
  budget: 'Budget {amount} {asset}',
  spent: 'Spent {amount} {asset}',
  departmentFor: 'Department for {handle}',
  noDepartment: 'No department',
  setDepartment: 'Set department',
  joinBody: 'You were invited to join a business bank team.',
  join: 'Join',
  joined: 'You joined {name}.',
  joinNoLink: 'This page needs the link from your invitation.',
  goToTeam: 'Open the team',
});
type T = ReturnType<typeof copy.useCopy>['t'];

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A refusal shown in place, with its code, so the person (and a test) sees exactly what the bank said. */
function Refused({ out, t }: { out: Failed | null; t: T }) {
  if (!out) return null;
  return (
    <p role="alert" data-testid="team-refusal" data-code={out.code ?? ''}>
      {t('refusedTitle')}: {out.message}
    </p>
  );
}

function newId(): string {
  return crypto.randomUUID();
}

const perms = (list: readonly BusinessTeamPermission[], t: T) => list.map((p) => t(`perm_${p}`)).join(', ');

function signedOutState(t: T, path: string): RoomState {
  return {
    kind: 'refused',
    refusal: {
      variant: 'refused',
      title: t('signedOutTitle'),
      body: t('signedOutBody'),
      action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(path)}` },
    },
  };
}

/**
 * One read of the bank. `base` names what is read (it changes when the business or payment does); `rev` reloads it. While
 * a reload of the same read is on its way the last answer stays on screen, so a change never blanks the room and the
 * refusal or link it just showed stays with it.
 */
function useBank<S>(
  procedure: string,
  input: unknown,
  schema: ZodType<S>,
  base: string,
  rev = 0,
): { resource: Resource<S>; reload: () => void } {
  const { api, userId } = useSession();
  const read = useResource<S>(
    (signal) =>
      userId && input !== null
        ? api.query('bank', procedure, input, schema, { signal })
        : Promise.resolve({ ok: false as const, reason: 'unauthorized' as const, message: '' }),
    `team:${procedure}:${userId ?? 'out'}:${base}:${rev}`,
  );
  const kept = useRef<{ base: string; data: S } | null>(null);
  const keyed = `${userId ?? 'out'}:${base}`;
  if (read.resource.status === 'ready') kept.current = { base: keyed, data: read.resource.data };
  if (read.resource.status === 'loading' && kept.current?.base === keyed) {
    return { resource: { status: 'ready', data: kept.current.data }, reload: read.reload };
  }
  return read;
}

/** A change through the bank: the refusal it gives is kept to show, and every read reloads after a success. */
function useChange(after: () => void) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [notice, setNotice] = useState('');
  async function run<S>(
    procedure: string,
    body: unknown,
    schema: ZodType<S>,
    done?: (data: S) => string,
    held?: HeldId,
  ): Promise<S | null> {
    if (busy) return null;
    setBusy(true);
    setFailed(null);
    setNotice('');
    const out = await api.mutate('bank', procedure, body, schema);
    setBusy(false);
    held?.settle(out);
    if (!out.ok) {
      setFailed(out);
      after();
      return null;
    }
    if (done) setNotice(done(out.data));
    after();
    return out.data;
  }
  return { busy, failed, notice, run };
}

function Notice({ text }: { text: string }) {
  return text ? (
    <p role="status" data-testid="team-notice">
      {text}
    </p>
  ) : null;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`team-${id}`} data-testid={`team-${id}`}>
      <h2 id={`team-${id}`}>{title}</h2>
      {children}
    </section>
  );
}

function ruleLine(rule: BusinessTeamRule, assetId: string, t: T): string {
  return t('ruleLine', {
    amount: rule.overAmount,
    asset: assetId,
    payee: rule.payee ?? t('anyPayee'),
    type: rule.paymentType ? t(`type_${rule.paymentType}`) : t('anyType'),
    n: rule.approvals,
  });
}

function paymentStatus(p: BusinessTeamPayment, label: string, t: T): string {
  switch (p.status) {
    case 'pending':
      return t('pay_pending', { left: Math.max(0, p.approvalsNeeded - p.approvals.length) });
    case 'sending':
      return t('pay_sending');
    case 'sent':
      return t('pay_sent', { label });
    case 'refused':
      return t('pay_refused');
    case 'rejected':
      return t('pay_rejected');
  }
}

function BalanceLine({ o, t }: { o: BusinessTeamOverview; t: T }) {
  if (!o.partner) return <p data-testid="team-balance">{t('balanceNone')}</p>;
  return (
    <p data-testid="team-balance" data-amount={o.partner.amount ?? ''}>
      {o.partner.amount === null ? (
        t('balanceNotKnown', { label: o.partner.label })
      ) : (
        <>
          {t('balance', { label: o.partner.label })}: {o.partner.amount} {o.account.assetId}
          {o.partner.asOf ? (
            <>
              {' '}
              {t('asOf')} <time dateTime={o.partner.asOf}>{new Date(o.partner.asOf).toLocaleString()}</time>
            </>
          ) : null}
        </>
      )}
    </p>
  );
}

function MemberLine({ m, t }: { m: BusinessTeamMember; t: T }) {
  return (
    <>
      <strong>@{m.handle}</strong> · {m.advisor ? t('advisor') : (m.customRole?.name ?? m.role)} ·{' '}
      <span data-testid="team-member-can">
        {t('can')}: {perms(m.permissions, t)}
      </span>
    </>
  );
}

/** `/bank/business/team` and `/bank/business/spend`. */
export function BusinessTeamRoom({ part }: { part: 'team' | 'spend' }) {
  const { t } = copy.useCopy();
  const { userId, profiles } = useSession();
  const business = profiles.business;
  const accountId = business?.accountId ?? null;
  const input = accountId ? { accountId } : null;
  const overview = useBank('businessTeam.overview', input, businessTeamOverviewSchema, accountId ?? '-');
  const path = part === 'team' ? '/bank/business/team' : '/bank/business/spend';
  let state: RoomState = { kind: 'ready' };
  if (!userId) state = signedOutState(t, path);
  else if (!business) state = { kind: 'refused', refusal: { variant: 'refused', title: t('personalTitle'), body: t('personalBody') } };
  else if (overview.resource.status === 'failed')
    state = {
      kind: 'refused',
      refusal: { variant: 'refused', title: t('readFailedTitle'), body: overview.resource.failure.message },
    };
  else if (overview.resource.status !== 'ready') state = { kind: 'loading' };
  const o = overview.resource.status === 'ready' ? overview.resource.data : null;
  return (
    <FlowTemplate
      title={part === 'team' ? t('title') : t('spendTitle')}
      description={part === 'team' ? t('description') : t('spendDescription')}
      state={state}
      step={
        o && accountId ? (
          <div data-testid="team-room" data-account={accountId}>
            <p data-testid="team-business">{o.account.name}</p>
            <p data-testid="team-me" data-permissions={o.me.permissions.join(' ')}>
              {t('yourRole')}: {o.owner ? `${t('owner')} · ` : ''}
              <MemberLine m={o.me} t={t} />
            </p>
            <BalanceLine o={o} t={t} />
            {part === 'team' ? <TeamParts o={o} reloadTop={overview.reload} t={t} /> : <SpendPart o={o} t={t} />}
          </div>
        ) : null
      }
      summary={
        <div>
          <h2>{t('rulesTitle')}</h2>
          <p>{t('rulesBody')}</p>
          <p>{t('advisorsBody')}</p>
        </div>
      }
    />
  );
}

function TeamParts({ o, reloadTop, t }: { o: BusinessTeamOverview; reloadTop: () => void; t: T }) {
  const accountId = o.account.id;
  const input = { accountId };
  const [rev, setRev] = useState(0);
  const key = accountId;
  const roles = useBank('businessTeam.roles', input, z.array(businessTeamRoleSchema), key, rev);
  const members = useBank('businessTeam.members', input, z.array(businessTeamMemberSchema), key, rev);
  const advisors = useBank('businessTeam.advisors', input, z.array(businessTeamAdvisorSchema), key, rev);
  const manage = o.me.permissions.includes('manage_team');
  const invites = useBank('businessTeam.invites', manage ? input : null, z.array(businessTeamInviteSchema), key, rev);
  const rules = useBank('businessTeam.rules', input, z.array(businessTeamRuleSchema), key, rev);
  const payments = useBank('businessTeam.payments', input, z.array(businessTeamPaymentSchema), key, rev);
  // Each form keeps its request's id until the bank answers it (useHeldId), so a press after a lost answer is the same request.
  const roleId = useHeldId();
  const inviteId = useHeldId();
  const ruleId = useHeldId();
  const paymentId = useHeldId();
  const change = useChange(() => {
    setRev((n) => n + 1);
    reloadTop();
  });
  const roleList = roles.resource.status === 'ready' ? roles.resource.data : [];
  const memberList = members.resource.status === 'ready' ? members.resource.data : [];

  const [roleName, setRoleName] = useState('');
  const [rolePerms, setRolePerms] = useState<BusinessTeamPermission[]>([]);
  const [advisorHandle, setAdvisorHandle] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('builtin:viewer');
  const [link, setLink] = useState<{ url: string; email: string | null } | null>(null);
  const [ruleOver, setRuleOver] = useState('');
  const [rulePayee, setRulePayee] = useState('');
  const [ruleType, setRuleType] = useState('');
  const [ruleApprovals, setRuleApprovals] = useState('1');
  const [payee, setPayee] = useState('');
  const [payType, setPayType] = useState<(typeof BUSINESS_PAYMENT_TYPES)[number]>('domestic');
  const [payAmount, setPayAmount] = useState('');
  const [memberRole, setMemberRole] = useState<Record<string, string>>({});

  const roleChoice = (value: string) =>
    value.startsWith('custom:') ? { role: null, roleId: value.slice(7) } : { role: value.slice(8), roleId: null };
  const madeLink = (token: string | null, email: string | null) => {
    if (token) setLink({ url: `${window.location.origin}/bank/business/join#${token}`, email });
  };

  return (
    <>
      <Notice text={change.notice} />
      <Refused out={change.failed} t={t} />

      <Section id="roles" title={t('rolesTitle')}>
        {roleList.length === 0 ? <p>{t('rolesEmpty')}</p> : null}
        <ul>
          {roleList.map((r) => (
            <li key={r.id} data-testid="team-role" data-name={r.name} data-permissions={r.permissions.join(' ')}>
              <strong>{r.name}</strong> · {t('can')}: {perms(r.permissions, t)}
            </li>
          ))}
        </ul>
        <form
          aria-label={t('createRole')}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void change
              .run(
                'businessTeam.createRole',
                { accountId, roleId: roleId.id, name: roleName.trim(), permissions: rolePerms },
                businessTeamRoleSchema,
                (r) => t('roleCreated', { name: r.name }),
                roleId,
              )
              .then((r) => {
                if (r) {
                  setRoleName('');
                  setRolePerms([]);
                }
              });
          }}
        >
          <label className="field">
            <span>{t('roleName')}</span>
            <input name="roleName" value={roleName} onChange={(e) => setRoleName(e.target.value)} />
          </label>
          <fieldset>
            {BUSINESS_TEAM_PERMISSIONS.map((p) => (
              <label key={p} className="field">
                <input
                  type="checkbox"
                  name="permissions"
                  value={p}
                  checked={rolePerms.includes(p)}
                  onChange={(e) => setRolePerms(e.target.checked ? [...rolePerms, p] : rolePerms.filter((x) => x !== p))}
                />
                <span>{t(`perm_${p}`)}</span>
              </label>
            ))}
          </fieldset>
          <Button type="submit" variant="primary" disabled={change.busy || !roleName.trim() || rolePerms.length === 0}>
            {t('createRole')}
          </Button>
        </form>
      </Section>

      <Section id="members" title={t('membersTitle')}>
        <ul>
          {memberList.map((m) => (
            <li key={m.userId} data-testid="team-member" data-handle={m.handle} data-permissions={m.permissions.join(' ')}>
              <MemberLine m={m} t={t} />
              {manage && !m.advisor && m.userId !== o.me.userId ? (
                <span>
                  {' '}
                  <label>
                    <span className="sr-only">{t('roleFor', { handle: m.handle })}</span>
                    <select
                      aria-label={t('roleFor', { handle: m.handle })}
                      value={memberRole[m.userId] ?? (m.customRole ? m.customRole.id : '')}
                      onChange={(e) => setMemberRole({ ...memberRole, [m.userId]: e.target.value })}
                    >
                      <option value="">{t('builtIn')}</option>
                      {roleList.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>{' '}
                  <Button
                    type="button"
                    disabled={change.busy}
                    onClick={() =>
                      void change.run(
                        'businessTeam.assignRole',
                        { accountId, userId: m.userId, roleId: (memberRole[m.userId] ?? m.customRole?.id ?? '') || null },
                        businessTeamMemberSchema,
                        () => t('roleChanged'),
                      )
                    }
                  >
                    {t('changeRole')}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="advisors" title={t('advisorsTitle')}>
        <p>{t('advisorsBody')}</p>
        {advisors.resource.status === 'ready' && advisors.resource.data.length === 0 ? <p>{t('advisorsEmpty')}</p> : null}
        <ul>
          {(advisors.resource.status === 'ready' ? advisors.resource.data : []).map((a) => (
            <li key={a.userId} data-testid="team-advisor" data-handle={a.handle} data-status={a.status}>
              <strong>@{a.handle}</strong> · {a.status === 'pending' ? t('advisorWaiting') : t('advisorApproved')} ·{' '}
              {t('addedBy', { handle: a.addedByHandle })}
              {a.status === 'pending' ? (
                <>
                  {' '}
                  <Button
                    type="button"
                    disabled={change.busy}
                    onClick={() =>
                      void change.run('businessTeam.approveAdvisor', { accountId, userId: a.userId }, businessTeamAdvisorSchema, () =>
                        t('advisorApproved'),
                      )
                    }
                  >
                    {t('approveAdvisor')}
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
        {manage ? (
          <form
            aria-label={t('addAdvisor')}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void change
                .run('businessTeam.addAdvisor', { accountId, handle: advisorHandle.trim() }, businessTeamAdvisorSchema, (a) =>
                  a.status === 'pending' ? t('advisorWaiting') : t('advisorApproved'),
                )
                .then((a) => a && setAdvisorHandle(''));
            }}
          >
            <label className="field">
              <span>{t('advisorHandle')}</span>
              <input name="advisorHandle" autoCapitalize="none" value={advisorHandle} onChange={(e) => setAdvisorHandle(e.target.value)} />
            </label>
            <Button type="submit" disabled={change.busy || !advisorHandle.trim()}>
              {t('addAdvisor')}
            </Button>
          </form>
        ) : null}
      </Section>

      {manage ? (
        <Section id="invites" title={t('invitesTitle')}>
          <p data-testid="team-invite-lifetime">
            {o.inviteMinutes === null ? t('invitesLifetimeNotSet') : t('invitesLifetime', { n: o.inviteMinutes })}
          </p>
          <form
            aria-label={t('sendInvite')}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const email = inviteEmail.trim() || null;
              void change
                .run(
                  'businessTeam.invite',
                  { accountId, inviteId: inviteId.id, email, ...roleChoice(inviteRole) },
                  businessTeamInviteMadeSchema,
                  undefined,
                  inviteId,
                )
                .then((made) => {
                  if (made) {
                    madeLink(made.token, made.invite.email);
                    setInviteEmail('');
                  }
                });
            }}
          >
            <label className="field">
              <span>{t('inviteEmail')}</span>
              <input
                name="inviteEmail"
                type="email"
                autoCapitalize="none"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </label>
            <label className="field">
              <span>{t('inviteRole')}</span>
              <select name="inviteRole" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                {['viewer', 'maker', 'checker', 'admin'].map((r) => (
                  <option key={r} value={`builtin:${r}`}>
                    {r}
                  </option>
                ))}
                {roleList.map((r) => (
                  <option key={r.id} value={`custom:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="primary" disabled={change.busy}>
              {t('sendInvite')}
            </Button>
          </form>
          {link ? (
            <div data-testid="team-invite-link">
              <p>{link.email ? t('inviteLinkEmail', { email: link.email }) : t('inviteLinkOnly')}</p>
              <label className="field">
                <span>{t('inviteLink')}</span>
                <input readOnly name="inviteLink" value={link.url} />
              </label>
            </div>
          ) : null}
          {invites.resource.status === 'ready' && invites.resource.data.length === 0 ? <p>{t('invitesEmpty')}</p> : null}
          <ul>
            {(invites.resource.status === 'ready' ? invites.resource.data : []).map((i) => (
              <li key={i.id} data-testid="team-invite" data-invite={i.id} data-status={i.status} data-email={i.email ?? ''}>
                {i.email ? t('inviteTo', { email: i.email }) : t('inviteByLink')} · {i.customRole?.name ?? i.role} ·{' '}
                {t(`status_${i.status}`)}
                {i.status === 'open' ? (
                  <>
                    {' '}
                    {t('until')} <time dateTime={i.expiresAt}>{new Date(i.expiresAt).toLocaleString()}</time>
                  </>
                ) : null}
                {i.status === 'open' || i.status === 'expired' ? (
                  <>
                    {' '}
                    <Button
                      type="button"
                      disabled={change.busy}
                      onClick={() =>
                        void change
                          .run(
                            'businessTeam.resendInvite',
                            { accountId, inviteId: i.id, newInviteId: newId() },
                            businessTeamInviteMadeSchema,
                          )
                          .then((made) => made && madeLink(made.token, made.invite.email))
                      }
                    >
                      {t('resend')}
                    </Button>
                  </>
                ) : null}
                {i.status === 'open' ? (
                  <>
                    {' '}
                    <Button
                      type="button"
                      disabled={change.busy}
                      onClick={() => void change.run('businessTeam.revokeInvite', { accountId, inviteId: i.id }, businessTeamInviteSchema)}
                    >
                      {t('revoke')}
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section id="rules" title={t('rulesTitle')}>
        <p>{t('rulesBody')}</p>
        {rules.resource.status === 'ready' && rules.resource.data.length === 0 ? <p>{t('rulesEmpty')}</p> : null}
        <ul>
          {(rules.resource.status === 'ready' ? rules.resource.data : []).map((r) => (
            <li key={r.id} data-testid="team-rule" data-over={r.overAmount} data-approvals={r.approvals}>
              {ruleLine(r, o.account.assetId, t)}
            </li>
          ))}
        </ul>
        {manage ? (
          <form
            aria-label={t('saveRule')}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void change
                .run(
                  'businessTeam.addRule',
                  {
                    accountId,
                    ruleId: ruleId.id,
                    overAmount: ruleOver.trim(),
                    payee: rulePayee.trim() || null,
                    paymentType: ruleType || null,
                    approvals: Number(ruleApprovals),
                  },
                  businessTeamRuleSchema,
                  () => t('ruleSaved'),
                  ruleId,
                )
                .then((r) => {
                  if (r) {
                    setRuleOver('');
                    setRulePayee('');
                  }
                });
            }}
          >
            <label className="field">
              <span>
                {t('ruleOver')} ({o.account.assetId})
              </span>
              <input name="ruleOver" inputMode="decimal" value={ruleOver} onChange={(e) => setRuleOver(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('rulePayee')}</span>
              <input name="rulePayee" value={rulePayee} onChange={(e) => setRulePayee(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('ruleType')}</span>
              <select name="ruleType" value={ruleType} onChange={(e) => setRuleType(e.target.value)}>
                <option value="">{t('anyType')}</option>
                {BUSINESS_PAYMENT_TYPES.map((p) => (
                  <option key={p} value={p}>
                    {t(`type_${p}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('ruleApprovals')}</span>
              <select name="ruleApprovals" value={ruleApprovals} onChange={(e) => setRuleApprovals(e.target.value)}>
                {['1', '2', '3', '4', '5'].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="primary" disabled={change.busy || !ruleOver.trim()}>
              {t('saveRule')}
            </Button>
          </form>
        ) : null}
      </Section>

      <Section id="payments" title={t('paymentsTitle')}>
        {payments.resource.status === 'ready' && payments.resource.data.length === 0 ? <p>{t('paymentsEmpty')}</p> : null}
        <ul>
          {(payments.resource.status === 'ready' ? payments.resource.data : []).map((p) => (
            <li key={p.id} data-testid="team-payment" data-payment={p.id} data-status={p.status} data-amount={p.amount}>
              {p.payee} · {p.amount} {p.assetId} · {paymentStatus(p, o.partner?.label ?? '', t)}{' '}
              <a className="text-link" href={`/bank/business/payment?id=${p.id}`}>
                {t('open')}
              </a>
            </li>
          ))}
        </ul>
        {o.me.permissions.includes('propose') ? (
          <form
            aria-label={t('propose')}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void change
                .run(
                  'businessTeam.propose',
                  { accountId, paymentId: paymentId.id, payee: payee.trim(), paymentType: payType, amount: payAmount.trim() },
                  businessTeamPaymentSchema,
                  () => t('proposed'),
                  paymentId,
                )
                .then((p) => {
                  if (p) {
                    setPayee('');
                    setPayAmount('');
                  }
                });
            }}
          >
            <label className="field">
              <span>{t('payee')}</span>
              <input name="payee" value={payee} onChange={(e) => setPayee(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('ruleType')}</span>
              <select
                name="paymentType"
                value={payType}
                onChange={(e) => setPayType(e.target.value as (typeof BUSINESS_PAYMENT_TYPES)[number])}
              >
                {BUSINESS_PAYMENT_TYPES.map((p) => (
                  <option key={p} value={p}>
                    {t(`type_${p}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>
                {t('amount')} ({o.account.assetId})
              </span>
              <input name="amount" inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            </label>
            <Button type="submit" variant="primary" disabled={change.busy || !payee.trim() || !payAmount.trim()}>
              {t('propose')}
            </Button>
          </form>
        ) : null}
      </Section>
    </>
  );
}

function SpendPart({ o, t }: { o: BusinessTeamOverview; t: T }) {
  const accountId = o.account.id;
  const [rev, setRev] = useState(0);
  const spend = useBank('businessTeam.spend', { accountId }, businessTeamSpendSchema, accountId, rev);
  const manage = o.me.permissions.includes('manage_team');
  const departmentId = useHeldId();
  const change = useChange(() => setRev((n) => n + 1));
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  if (spend.resource.status === 'failed') return <p role="alert">{spend.resource.failure.message}</p>;
  if (spend.resource.status !== 'ready') return null;
  const s = spend.resource.data;
  return (
    <>
      <Notice text={change.notice} />
      <Refused out={change.failed} t={t} />
      <Section id="spend" title={t('spendTitle')}>
        {s.scope === 'self' ? <p data-testid="team-spend-self">{t('spendScopeSelf')}</p> : null}
        <table data-testid="team-spend-table">
          <thead>
            <tr>
              <th scope="col">{t('spendMember')}</th>
              <th scope="col">
                {t('spendPartner')} ({s.partnerLabel})
              </th>
              <th scope="col">{t('spendRecord')}</th>
            </tr>
          </thead>
          <tbody>
            {s.members.map((m) => (
              <tr
                key={m.userId}
                data-testid="team-spend-member"
                data-handle={m.handle}
                data-partner={m.partnerTotal}
                data-record={m.recordTotal}
                data-lines={m.partnerLines}
              >
                <th scope="row">@{m.handle}</th>
                <td>
                  {m.partnerTotal} {s.assetId} · {t('spendLines', { n: m.partnerLines })}
                </td>
                <td>
                  {m.recordTotal} {s.assetId}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {s.scope === 'team' ? (
        <Section id="departments" title={t('departmentsTitle')}>
          {s.departments.length === 0 ? <p>{t('departmentsEmpty')}</p> : null}
          <ul>
            {s.departments.map((d) => (
              <li key={d.id} data-testid="team-department" data-name={d.name} data-budget={d.budget ?? ''} data-spent={d.spent}>
                <strong>{d.name}</strong> ·{' '}
                <span data-testid="team-department-budget">
                  {d.budget === null ? t('budgetNotSet') : t('budget', { amount: d.budget, asset: s.assetId })}
                </span>{' '}
                · {t('spent', { amount: d.spent, asset: s.assetId })}
              </li>
            ))}
          </ul>
          {manage ? (
            <>
              <form
                aria-label={t('addDepartment')}
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void change
                    .run(
                      'businessTeam.addDepartment',
                      { accountId, departmentId: departmentId.id, name: name.trim(), budget: budget.trim() || null },
                      businessTeamDepartmentSchema,
                      undefined,
                      departmentId,
                    )
                    .then((d) => {
                      if (d) {
                        setName('');
                        setBudget('');
                      }
                    });
                }}
              >
                <label className="field">
                  <span>{t('departmentName')}</span>
                  <input name="departmentName" value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="field">
                  <span>{t('departmentBudget')}</span>
                  <input name="departmentBudget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
                </label>
                <Button type="submit" disabled={change.busy || !name.trim()}>
                  {t('addDepartment')}
                </Button>
              </form>
              <ul>
                {s.members.map((m) => (
                  <li key={m.userId}>
                    <label>
                      <span>{t('departmentFor', { handle: m.handle })}</span>{' '}
                      <select
                        aria-label={t('departmentFor', { handle: m.handle })}
                        value={picked[m.userId] ?? m.departmentId ?? ''}
                        onChange={(e) => setPicked({ ...picked, [m.userId]: e.target.value })}
                      >
                        <option value="">{t('noDepartment')}</option>
                        {s.departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </label>{' '}
                    <Button
                      type="button"
                      disabled={change.busy}
                      onClick={() =>
                        void change.run(
                          'businessTeam.setDepartment',
                          { accountId, userId: m.userId, departmentId: (picked[m.userId] ?? m.departmentId ?? '') || null },
                          businessTeamMemberSchema,
                        )
                      }
                    >
                      {t('setDepartment')}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

/** `/bank/business/payment?id=<payment id>`: the rule that applied, each approval and the result. */
export function BusinessPaymentRoom({ search }: { search: string }) {
  const { t } = copy.useCopy();
  const { userId } = useSession();
  const paymentId = new URLSearchParams(search).get('id');
  const valid = paymentId !== null && /^[0-9a-f-]{36}$/i.test(paymentId);
  const [rev, setRev] = useState(0);
  const read = useBank('businessTeam.payment', valid ? { paymentId } : null, businessTeamPaymentSchema, paymentId ?? '-', rev);
  const p = read.resource.status === 'ready' ? read.resource.data : null;
  const overview = useBank('businessTeam.overview', p ? { accountId: p.accountId } : null, businessTeamOverviewSchema, p?.accountId ?? '-');
  const o = overview.resource.status === 'ready' ? overview.resource.data : null;
  const change = useChange(() => setRev((n) => n + 1));
  let state: RoomState = { kind: 'ready' };
  if (!userId) state = signedOutState(t, `/bank/business/payment${search}`);
  else if (read.resource.status === 'failed' || !valid)
    state = {
      kind: 'refused',
      refusal: {
        variant: 'refused',
        title: t('readFailedTitle'),
        body: read.resource.status === 'failed' ? read.resource.failure.message : '',
      },
    };
  else if (!p) state = { kind: 'loading' };
  const label = o?.partner?.label ?? '';
  const mine = p && userId ? p.approvals.some((a) => a.userId === userId) : false;
  return (
    <FlowTemplate
      title={t('paymentTitle')}
      description={t('paymentDescription')}
      state={state}
      step={
        p ? (
          <div data-testid="team-payment-detail" data-payment={p.id} data-status={p.status}>
            <p>
              <strong>{p.payee}</strong> · {p.amount} {p.assetId} · {t(`type_${p.paymentType}`)}
            </p>
            <p>{t('proposedBy', { handle: p.makerHandle })}</p>
            <Section id="rule" title={t('ruleApplied')}>
              <p data-testid="team-payment-rule" data-over={p.rule?.overAmount ?? ''} data-needed={p.approvalsNeeded}>
                {p.rule ? ruleLine(p.rule, p.assetId, t) : t('noRule')}
              </p>
            </Section>
            <Section id="approvals" title={t('approvalsTitle')}>
              {p.approvals.length === 0 ? <p>{t('approvalsNone')}</p> : null}
              <ol>
                {p.approvals.map((a) => (
                  <li key={a.userId} data-testid="team-payment-approval" data-handle={a.handle}>
                    {t('approvedBy', { handle: a.handle })} <time dateTime={a.approvedAt}>{new Date(a.approvedAt).toLocaleString()}</time>
                  </li>
                ))}
              </ol>
            </Section>
            <Section id="result" title={t('result')}>
              <p data-testid="team-payment-result" data-status={p.status} data-move={p.partnerMoveId ?? ''}>
                {paymentStatus(p, label, t)}
                {p.refusalCode ? ` (${p.refusalCode})` : ''}
              </p>
              {p.partnerMoveId ? (
                <p>
                  {t('partnerRef')}: <code>{p.partnerMoveId}</code>
                </p>
              ) : null}
            </Section>
            <Notice text={change.notice} />
            <Refused out={change.failed} t={t} />
            <div>
              {p.status === 'pending' ? (
                <>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={change.busy}
                    onClick={() =>
                      void change.run('businessTeam.approve', { paymentId: p.id }, businessTeamPaymentSchema, () => t('approved'))
                    }
                  >
                    {t('approve')}
                  </Button>{' '}
                  <Button
                    type="button"
                    disabled={change.busy}
                    onClick={() => void change.run('businessTeam.reject', { paymentId: p.id }, businessTeamPaymentSchema)}
                  >
                    {t('decline')}
                  </Button>
                </>
              ) : null}
              {p.status === 'sending' ? (
                <Button
                  type="button"
                  disabled={change.busy}
                  onClick={() =>
                    void change.run(mine ? 'businessTeam.approve' : 'businessTeam.resend', { paymentId: p.id }, businessTeamPaymentSchema)
                  }
                >
                  {t('tryAgain')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null
      }
      summary={
        <div>
          <h2>{t('rulesTitle')}</h2>
          <p>{t('rulesBody')}</p>
        </div>
      }
    />
  );
}

/** `/bank/business/join#<secret>`: the invitee joins. The secret stays in the fragment, never sent as part of the URL. */
export function BusinessJoinRoom() {
  const { t } = copy.useCopy();
  const { userId, profiles } = useSession();
  const token = typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '');
  const change = useChange(() => profiles.reload());
  const [joined, setJoined] = useState<string | null>(null);
  let state: RoomState = { kind: 'ready' };
  if (!userId) state = signedOutState(t, `/bank/business/join${typeof window === 'undefined' ? '' : window.location.hash}`);
  else if (!token) state = { kind: 'refused', refusal: { variant: 'refused', title: t('joinTitle'), body: t('joinNoLink') } };
  return (
    <FlowTemplate
      title={t('joinTitle')}
      description={t('joinDescription')}
      state={state}
      step={
        <div data-testid="team-join">
          <p>{t('joinBody')}</p>
          <Refused out={change.failed} t={t} />
          {joined ? (
            <p role="status" data-testid="team-joined">
              {t('joined', { name: joined })}{' '}
              <a className="text-link" href="/bank/business/team">
                {t('goToTeam')}
              </a>
            </p>
          ) : (
            <Button
              type="button"
              variant="primary"
              disabled={change.busy}
              onClick={() =>
                void change.run('businessTeam.acceptInvite', { token }, businessTeamJoinedSchema).then((j) => j && setJoined(j.name))
              }
            >
              {t('join')}
            </Button>
          )}
        </div>
      }
      summary={
        <div>
          <p>{t('advisorsBody')}</p>
        </div>
      }
    />
  );
}
