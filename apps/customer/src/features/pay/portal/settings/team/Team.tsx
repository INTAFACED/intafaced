import { useState } from 'react';
import { DataTable } from '@intafaced/ui';
import { Field } from '../../../ui-kit';
import { useResource, type Resource } from '../../../../../shared/resource';
import { useSession } from '../../../../session/session';
import { PaySection } from '../../../components';
import { Chip, Gate, ListShell, MoreFooter, SelectField } from '../../components';
import { useCursorList, useMemberNames, useUrlParam, type ListState } from '../../hooks';
import type { PortalApi } from '../../api';
import { teamRoles, type Invitation, type Member, type MemberRole, type TeamEvent, type TeamRole } from '../../schemas';
import { DateTime } from '../../ui/DateTime';
import { EntityList } from '../../ui/EntityList';
import { PortalReview } from '../../ui/PortalReview';
import { Timeline } from '../../ui/Timeline';
import { useServerList } from '../../ui/useServerList';
import { useUnsavedForm } from '../../useUnsavedForm';
import { actorName } from '../account/actors';
import { accountCopy } from '../account/copy';
import { memberKey, memberName, pinOwner } from '../account/model';
import { extensionCopy, portalCopy } from '../copy';
import { grantableRoles, memberActions } from '../model';

type TeamMe = { merchantId: string; userId: string; role: MemberRole };
type Filters = { search: string; role: string; status: string };

/** `/pay/team`: who is on the account, what each may do, and every change to it. */
export function Team({ portal }: { portal: PortalApi }) {
  const [search, setSearch] = useUrlParam('q');
  const [role, setRole] = useUrlParam('role');
  const [status, setStatus] = useUrlParam('status');
  const [member, setMember] = useUrlParam('member');
  const { userId } = useSession();
  const names = useMemberNames(portal);
  const me = useResource((s) => portal.teamMe(s), 'portal:team-me');
  const invitations = useResource((s) => portal.myInvitations(s), 'portal:team-invites');
  const filters: Filters = { search: search.trim(), role, status };
  const members = useServerList((f: Filters, cursor, signal) => portal.teamPage(cursor, f, signal), filters, memberKey);
  const history = useCursorList(
    (cursor, s) => portal.teamHistory(cursor, s),
    'portal:team-history',
    (e) => e.seq,
  );
  const refresh = () => {
    members.reload();
    history.reload();
    me.reload();
    invitations.reload();
  };
  return (
    <TeamView
      portal={portal}
      me={me.resource}
      myUserId={userId}
      names={names}
      invitations={invitations.resource}
      members={members.state}
      history={history.state}
      filters={{ search, setSearch, role, setRole, status, setStatus }}
      selected={member}
      select={setMember}
      loadMoreMembers={members.loadMore}
      loadMoreHistory={history.loadMore}
      refresh={refresh}
    />
  );
}

export function TeamView(props: {
  portal: PortalApi;
  me: Resource<TeamMe>;
  myUserId: string | null;
  names: ReadonlyMap<string, string>;
  invitations: Resource<Invitation[]>;
  members: ListState<Member>;
  history: ListState<TeamEvent>;
  filters: {
    search: string;
    setSearch: (v: string) => void;
    role: string;
    setRole: (v: string) => void;
    status: string;
    setStatus: (v: string) => void;
  };
  selected: string;
  select: (key: string) => void;
  loadMoreMembers: () => void;
  loadMoreHistory: () => void;
  refresh: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const { t: a } = accountCopy.useCopy();
  const { portal, refresh, filters } = props;
  const role = props.me.status === 'ready' ? props.me.data.role : null;
  const roleName = (r: string) => t(`role_${r}` as 'role_owner');
  const filtered = Boolean(filters.search || filters.role || filters.status);
  const rows = props.members.status === 'ready' ? pinOwner(props.members.items, a('teamMemberFallback')) : null;
  const chosen = rows?.find((m) => memberKey(m) === props.selected) ?? null;
  const nameOf = (m: Member) => (m.userId === props.myUserId ? a('actorYou') : memberName(m, a('teamMemberFallback')));
  return (
    <div className="stack">
      <p className="pp-callout" role="note">
        <strong>{t('mfaTitle')}</strong> {t('mfaBody')}
      </p>

      <Invitations portal={portal} invitations={props.invitations} refresh={refresh} />

      <PaySection title={t('membersTitle')} description={t('membersBody')}>
        <div className="pp-filterbar" role="search" aria-label={t('membersTitle')}>
          <div className="pp-filter-row">
            <Field
              label={extensionCopy.t('search')}
              value={filters.search}
              onChange={(e) => filters.setSearch(e.target.value)}
              hint={a('teamSearchHint')}
            />
            <SelectField
              label={t('colRole')}
              value={filters.role}
              onChange={filters.setRole}
              options={[['', t('filterAll')], ...(['owner', ...teamRoles] as const).map((r) => [r, roleName(r)] as const)]}
            />
            <SelectField
              label={t('filterStatus')}
              value={filters.status}
              onChange={filters.setStatus}
              options={[
                ['', t('filterAll')],
                ['active', t('chipMember_active')],
                ['invited', t('chipMember_invited')],
                ['removed', t('chipMember_removed')],
              ]}
            />
          </div>
          {filtered && (
            <button
              type="button"
              className="text-link"
              onClick={() => {
                filters.setSearch('');
                filters.setRole('');
                filters.setStatus('');
              }}
            >
              {a('acClearFilters')}
            </button>
          )}
        </div>
        <ListShell
          state={props.members}
          retry={refresh}
          empty={{ title: t('membersEmptyTitle'), body: filtered ? a('teamNoMatch') : t('membersEmptyBody') }}
        >
          {() => (
            <>
              <EntityList
                label={t('membersTitle')}
                rows={rows ?? []}
                rowKey={memberKey}
                href={(m) => `/pay/team?member=${encodeURIComponent(memberKey(m))}`}
                columns={[
                  {
                    header: t('colMember'),
                    cell: (m) => (
                      <>
                        <strong>{nameOf(m)}</strong>
                        {m.role === 'owner' && <small className="sa-pin pay-cell-note">{a('ownerPinned')}</small>}
                      </>
                    ),
                  },
                  { header: t('colRole'), cell: (m) => roleName(m.role) },
                  { header: t('colStatus'), cell: (m) => <Chip kind="member" value={m.status} /> },
                  { header: t('colSince'), cell: (m) => <DateTime value={m.activatedAt ?? m.createdAt} /> },
                ]}
                card={(m) => ({
                  title: `${nameOf(m)} · ${roleName(m.role)}`,
                  time: <DateTime value={m.activatedAt ?? m.createdAt} />,
                  status: <Chip kind="member" value={m.status} />,
                })}
              />
              {props.members.status === 'ready' && <MoreFooter state={props.members} onMore={props.loadMoreMembers} />}
            </>
          )}
        </ListShell>
      </PaySection>

      {chosen && (
        <MemberPanel
          member={chosen}
          name={nameOf(chosen)}
          me={role}
          portal={portal}
          inviter={chosen.invitedBy ? actorName(chosen.invitedBy, props.myUserId, props.names) : null}
          refresh={() => {
            props.select('');
            refresh();
          }}
          close={() => props.select('')}
        />
      )}

      <InviteForm portal={portal} role={role} refresh={refresh} />

      <PaySection title={t('rolesTitle')} description={t('rolesBody')}>
        <div className="pp-left">
          <DataTable label={t('rolesTitle')} headers={[t('colRole'), t('colCan')]}>
            {(['owner', ...teamRoles] as const).map((r) => (
              <tr key={r}>
                <th scope="row">{roleName(r)}</th>
                <td>{t(`roleCan_${r}` as 'roleCan_owner')}</td>
              </tr>
            ))}
          </DataTable>
        </div>
      </PaySection>

      <PaySection title={t('teamHistoryTitle')} description={t('teamHistoryBody')}>
        <ListShell state={props.history} retry={refresh} empty={{ title: t('teamHistoryEmptyTitle'), body: t('teamHistoryEmptyBody') }}>
          {(events) => (
            <>
              <Timeline
                label={t('teamHistoryTitle')}
                items={events.map((e) => ({
                  at: e.createdAt,
                  title: eventTitle(e, (id) => actorName(id, props.myUserId, props.names), t),
                  detail: t('byActor', { actor: actorName(e.actorId, props.myUserId, props.names) }),
                }))}
              />
              {props.history.status === 'ready' && <MoreFooter state={props.history} onMore={props.loadMoreHistory} />}
            </>
          )}
        </ListShell>
      </PaySection>
    </div>
  );
}

/** Invitations addressed to the signed-in person. Answering one is the only thing on this page a person with no business can do. */
function Invitations({ portal, invitations, refresh }: { portal: PortalApi; invitations: Resource<Invitation[]>; refresh: () => void }) {
  const { t } = portalCopy.useCopy();
  const roleName = (r: string) => t(`role_${r}` as 'role_owner');
  return (
    <Gate resource={invitations} retry={refresh} rows={1}>
      {(pending) =>
        pending.length === 0 ? null : (
          <PaySection title={t('invitesTitle')} description={t('invitesBody')}>
            <ul className="pp-cards">
              {pending.map((invite) => (
                <li key={invite.memberId} className="pp-card">
                  <div>
                    <strong>{t('inviteLine', { role: roleName(invite.role) })}</strong>
                    <small className="muted">
                      {t('invitedOn')} <DateTime value={invite.invitedAt} />
                    </small>
                  </div>
                  <div className="pp-actions">
                    <PortalReview
                      title={t('accept')}
                      description={t('acceptBody')}
                      perform={() => portal.acceptInvite(invite.memberId)}
                      onConfirmed={refresh}
                    />
                    <PortalReview
                      title={t('decline')}
                      description={t('declineBody')}
                      perform={() => portal.declineInvite(invite.memberId)}
                      onConfirmed={refresh}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </PaySection>
        )
      }
    </Gate>
  );
}

/** The same invitations for a person with no business account: the one thing on the team page that is theirs. */
export function InvitationsOnly({ portal }: { portal: PortalApi }) {
  const invitations = useResource((s) => portal.myInvitations(s), 'portal:team-invites');
  return <Invitations portal={portal} invitations={invitations.resource} refresh={invitations.reload} />;
}

type T = ReturnType<typeof portalCopy.useCopy>['t'];
function eventTitle(e: TeamEvent, who: (id: string) => string, t: T): string {
  const person = who(e.memberUserId);
  const r = (v: string | null) => (v ? t(`role_${v}` as 'role_owner') : '');
  switch (e.action) {
    case 'invited':
      return t('evInvited', { who: person, role: r(e.toRole) });
    case 'accepted':
      return t('evAccepted', { who: person });
    case 'declined':
      return t('evDeclined', { who: person });
    case 'removed':
      return t('evRemoved', { who: person });
    case 'role_changed':
      return t('evRoleChanged', { who: person, from: r(e.fromRole), to: r(e.toRole) });
    default:
      return t('evOther', { who: person });
  }
}

/** One person: their role and status, and (for someone who may manage the team) change the role or remove them. */
function MemberPanel({
  member,
  name,
  me,
  portal,
  inviter,
  refresh,
  close,
}: {
  member: Member;
  name: string;
  me: MemberRole | null;
  portal: PortalApi;
  inviter: string | null;
  refresh: () => void;
  close: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const { t: a } = accountCopy.useCopy();
  const options = grantableRoles(me).filter((r) => r !== member.role);
  const [next, setNext] = useState<TeamRole | ''>('');
  const actions = memberActions(me, member);
  const target: TeamRole | '' = options.includes(next as TeamRole) ? next : (options[0] ?? '');
  return (
    <PaySection
      title={a('memberPanelTitle', { name })}
      action={
        <button type="button" className="text-link" onClick={close}>
          {a('closePanel')}
        </button>
      }
    >
      <dl className="pp-facts">
        <div>
          <dt>{t('colRole')}</dt>
          <dd>{t(`role_${member.role}` as 'role_owner')}</dd>
        </div>
        <div>
          <dt>{t('colStatus')}</dt>
          <dd>
            <Chip kind="member" value={member.status} />
          </dd>
        </div>
        <div>
          <dt>{t('colSince')}</dt>
          <dd>
            <DateTime value={member.activatedAt ?? member.createdAt} />
          </dd>
        </div>
        {inviter && (
          <div>
            <dt>{a('invitedBy')}</dt>
            <dd>{inviter}</dd>
          </div>
        )}
      </dl>
      <p className="muted">{t(`roleCan_${member.role}` as 'roleCan_owner')}</p>
      {actions.canChange && member.memberId ? (
        <div className="pp-row-actions">
          <SelectField
            label={t('newRole')}
            value={target}
            onChange={(v) => setNext(v as TeamRole)}
            options={options.map((r) => [r, t(`role_${r}` as 'role_owner')] as const)}
          />
          <PortalReview
            title={t('changeRole')}
            description={t('changeRoleBody')}
            review={
              <p>
                {t('changeRoleReview', {
                  who: name,
                  from: t(`role_${member.role}` as 'role_owner'),
                  to: target ? t(`role_${target}` as 'role_owner') : '',
                })}
              </p>
            }
            perform={() => portal.changeRole(member.memberId!, target as TeamRole)}
            onConfirmed={refresh}
            disabled={!target}
          />
          <PortalReview
            title={t('remove')}
            variant="sell"
            description={t('removeBody')}
            review={<p>{t('removeReview', { who: name })}</p>}
            perform={() => portal.removeMember(member.memberId!)}
            onConfirmed={refresh}
          />
        </div>
      ) : (
        <p className="muted">
          {member.status === 'removed'
            ? t('noActionsRemoved')
            : actions.reason === 'owner'
              ? t('whyOwner')
              : actions.reason === 'admin'
                ? t('whyAdmin')
                : t('whyRole')}
        </p>
      )}
    </PaySection>
  );
}

function InviteForm({ portal, role, refresh }: { portal: PortalApi; role: MemberRole | null; refresh: () => void }) {
  const { t } = portalCopy.useCopy();
  const allowed = grantableRoles(role);
  const [userId, setUserId] = useState('');
  const [pick, setPick] = useState<TeamRole>('viewer');
  const [label, setLabel] = useState('');
  const chosen: TeamRole = allowed.includes(pick) ? pick : (allowed[allowed.length - 1] ?? 'viewer');
  const blocked = allowed.length === 0;
  useUnsavedForm(Boolean(userId || label), extensionCopy.t('draftWarning'));
  return (
    <div id="invite">
      <PaySection title={t('inviteTitle')} description={t('inviteBody')}>
        <div className="form-stack pp-form">
          <Field
            label={`${t('fUserId')} *`}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            hint={t('hUserId')}
            disabled={blocked}
            required
          />
          <div className="form-row">
            <SelectField
              label={`${t('fRole')} *`}
              value={chosen}
              onChange={(v) => setPick(v as TeamRole)}
              options={allowed.map((r) => [r, t(`role_${r}` as 'role_owner')] as const)}
              hint={blocked ? t('whyRole') : t(`roleCan_${chosen}` as 'roleCan_owner')}
              disabled={blocked}
            />
            <Field
              label={t('fLabel')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
              hint={t('hLabel')}
              disabled={blocked}
            />
          </div>
          <PortalReview
            title={t('sendInvite')}
            variant="primary"
            description={t('sendInviteBody')}
            review={<p>{t('inviteReview', { who: label.trim() || userId.trim(), role: t(`role_${chosen}` as 'role_owner') })}</p>}
            perform={() => portal.invite({ userId: userId.trim(), role: chosen, ...(label.trim() ? { label: label.trim() } : {}) })}
            onConfirmed={() => {
              setUserId('');
              setLabel('');
              refresh();
            }}
            disabled={blocked || userId.trim().length === 0}
            disabledReason={blocked ? t('whyRole') : undefined}
          />
          {blocked && <p className="muted pp-note">{t('whyRole')}</p>}
        </div>
      </PaySection>
    </div>
  );
}
