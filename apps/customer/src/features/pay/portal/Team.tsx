import { Arrives, ReadStamp, WindowExport } from './ExtensionTools';
import { extensionCopy as c } from './extension-copy';
import { useUnsavedForm } from './useUnsavedForm';
import { useState } from 'react';
import { useResource, type Resource } from '../../../shared/resource';
import { DataTable, Field } from '@intafaced/ui';
import { PayTime, PaySection, ReviewedAction } from '../components';
import { Kpi, KpiGrid, Chip, Gate, ListShell, MoreFooter, SelectField, Timeline } from './components';
import { portalCopy } from './copy';
import { useCursorList, useUrlParam, useReadAt, type ListState } from './hooks';
import { grantableRoles, memberActions } from './model';
import type { PortalApi } from './api';
import { teamRoles, type Invitation, type Member, type MemberRole, type TeamEvent, type TeamRole } from './schemas';

/** `/pay/team`: members, roles, invitations. Every change here is recorded in the history below it. */
export function Team({ portal }: { portal: PortalApi }) {
  const [status, setStatus] = useUrlParam('status', '');
  const me = useResource((s) => portal.teamMe(s), 'portal:team-me');
  const invitations = useResource((s) => portal.myInvitations(s), 'portal:team-invites');
  const members = useCursorList(
    (cursor, s) => portal.teamList(cursor, status, s),
    `portal:team:${status}`,
    (m) => m.memberId ?? `owner:${m.userId}`,
  );
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
      invitations={invitations.resource}
      members={members.state}
      history={history.state}
      status={status}
      setStatus={setStatus}
      loadMoreMembers={members.loadMore}
      loadMoreHistory={history.loadMore}
      refresh={refresh}
    />
  );
}

export function TeamView(props: {
  portal: PortalApi;
  me: Resource<{ merchantId: string; userId: string; role: MemberRole }>;
  invitations: Resource<Invitation[]>;
  members: ListState<Member>;
  history: ListState<TeamEvent>;
  status: string;
  setStatus: (value: string) => void;
  loadMoreMembers: () => void;
  loadMoreHistory: () => void;
  refresh: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const { portal, refresh } = props;
  const [search, setSearch] = useUrlParam('search');
  const [sort, setSort] = useUrlParam('sort', 'newest');
  const at = useReadAt(props.members.status === 'ready', props.members);
  const loaded = props.members.status === 'ready' ? props.members.items : null;
  const visible = loaded
    ?.filter((m) => `${m.userId} ${m.label ?? ''} ${m.role}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) =>
      sort === 'name'
        ? (a.label ?? a.userId).localeCompare(b.label ?? b.userId)
        : sort === 'oldest'
          ? a.createdAt.localeCompare(b.createdAt)
          : b.createdAt.localeCompare(a.createdAt),
    );
  const role = props.me.status === 'ready' ? props.me.data.role : null;
  const myUserId = props.me.status === 'ready' ? props.me.data.userId : null;
  const roleName = (r: string) => t(`role_${r}` as 'role_owner');
  return (
    <div className="stack">
      {loaded && (
        <>
          <KpiGrid label={c.t('loadedMetrics')}>
            {(['teamLoaded', 'teamActive', 'teamInvited', 'teamRemoved'] as const).map((key, i) => (
              <Kpi
                key={key}
                label={c.t(key)}
                period={c.t('loadedMetrics')}
                value={i === 0 ? loaded.length : loaded.filter((m) => m.status === ['', 'active', 'invited', 'removed'][i]).length}
                href={`/pay/team${i ? `?status=${['', 'active', 'invited', 'removed'][i]}` : ''}`}
              />
            ))}
          </KpiGrid>
          <ReadStamp at={at} />
        </>
      )}
      <Arrives>{c.t('teamGap')}</Arrives>
      <p className="pp-callout" role="note">
        <strong>{t('mfaTitle')}</strong> {t('mfaBody')}
      </p>

      <Gate resource={props.invitations} retry={refresh} rows={1}>
        {(pending) =>
          pending.length === 0 ? null : (
            <PaySection title={t('invitesTitle')} description={t('invitesBody')}>
              <ul className="pp-cards">
                {pending.map((invite) => (
                  <li key={invite.memberId} className="pp-card">
                    <div>
                      <strong>{t('inviteLine', { role: roleName(invite.role) })}</strong>
                      <small className="muted">
                        {t('invitedOn')} <PayTime value={invite.invitedAt} />
                      </small>
                    </div>
                    <div className="pp-actions">
                      <ReviewedAction
                        title={t('accept')}
                        variant="primary"
                        description={t('acceptBody')}
                        perform={() => portal.acceptInvite(invite.memberId)}
                        onConfirmed={refresh}
                      />
                      <ReviewedAction
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

      <PaySection
        title={t('membersTitle')}
        description={t('membersBody')}
        action={
          <SelectField
            label={t('filterStatus')}
            value={props.status}
            onChange={props.setStatus}
            options={[
              ['', t('filterAll')],
              ['active', t('chipMember_active')],
              ['invited', t('chipMember_invited')],
              ['removed', t('chipMember_removed')],
            ]}
          />
        }
      >
        <div className="pp-filter-row" role="search">
          <Field label={c.t('search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <SelectField
            label={c.t('sort')}
            value={sort}
            onChange={setSort}
            options={[
              ['newest', c.t('newest')],
              ['oldest', c.t('oldest')],
              ['name', c.t('nameSort')],
            ]}
          />
        </div>
        <p className="muted">{c.t('teamSeparation')}</p>
        <ListShell
          state={props.members.status === 'ready' ? { ...props.members, items: visible ?? props.members.items } : props.members}
          retry={refresh}
          empty={{ title: t('membersEmptyTitle'), body: t('membersEmptyBody') }}
        >
          {(rows) => (
            <>
              <DataTable label={t('membersTitle')} headers={[t('colMember'), t('colRole'), t('colStatus'), t('colSince'), t('colActions')]}>
                {rows.map((member) => (
                  <MemberRow
                    key={member.memberId ?? `owner:${member.userId}`}
                    member={member}
                    me={role}
                    myUserId={myUserId}
                    portal={portal}
                    refresh={refresh}
                  />
                ))}
              </DataTable>
              <p role="status">{c.t('shown', { count: rows.length })}</p>
              <WindowExport
                name="team-members"
                at={at}
                headers={['user_id', 'label', 'role', 'status', 'created_at', 'activated_at']}
                rows={rows.map((m) => [m.userId, m.label, m.role, m.status, m.createdAt, m.activatedAt])}
              />
              {props.members.status === 'ready' && <MoreFooter state={props.members} onMore={props.loadMoreMembers} />}
            </>
          )}
        </ListShell>
      </PaySection>

      <div id="invite">
        <InviteForm portal={portal} role={role} refresh={refresh} />
      </div>

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
                  title: eventTitle(e, t),
                  detail: t('byActor', { actor: e.actorId === myUserId ? t('you') : e.actorId }),
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

type T = ReturnType<typeof portalCopy.useCopy>['t'];
function eventTitle(e: TeamEvent, t: T): string {
  const who = e.memberUserId;
  const r = (v: string | null) => (v ? t(`role_${v}` as 'role_owner') : '');
  switch (e.action) {
    case 'invited':
      return t('evInvited', { who, role: r(e.toRole) });
    case 'accepted':
      return t('evAccepted', { who });
    case 'declined':
      return t('evDeclined', { who });
    case 'removed':
      return t('evRemoved', { who });
    case 'role_changed':
      return t('evRoleChanged', { who, from: r(e.fromRole), to: r(e.toRole) });
    default:
      return t('evOther', { who });
  }
}

function MemberRow({
  member,
  me,
  myUserId,
  portal,
  refresh,
}: {
  member: Member;
  me: MemberRole | null;
  myUserId: string | null;
  portal: PortalApi;
  refresh: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const options = grantableRoles(me).filter((r) => r !== member.role);
  const [next, setNext] = useState<TeamRole | ''>('');
  const actions = memberActions(me, member);
  const target: TeamRole | '' = options.includes(next as TeamRole) ? next : (options[0] ?? '');
  const you = member.userId === myUserId;
  return (
    <tr>
      <th scope="row">
        <span className="pp-mono">{member.userId}</span>
        {you && <small className="pay-cell-note">{t('you')}</small>}
        {member.label && <small className="pay-cell-note">{member.label}</small>}
      </th>
      <td>{t(`role_${member.role}` as 'role_owner')}</td>
      <td>
        <Chip kind="member" value={member.status} />
      </td>
      <td>
        <PayTime value={member.activatedAt ?? member.createdAt} />
      </td>
      <td>
        {actions.canChange && member.memberId ? (
          <div className="pp-row-actions">
            <SelectField
              label={t('newRole')}
              value={target}
              onChange={(v) => setNext(v as TeamRole)}
              options={options.map((r) => [r, t(`role_${r}` as 'role_owner')] as const)}
            />
            <ReviewedAction
              title={t('changeRole')}
              description={t('changeRoleBody')}
              review={
                <p>
                  {t('changeRoleReview', {
                    who: member.userId,
                    from: t(`role_${member.role}` as 'role_owner'),
                    to: target ? t(`role_${target}` as 'role_owner') : '',
                  })}
                </p>
              }
              perform={() => portal.changeRole(member.memberId!, target as TeamRole)}
              onConfirmed={refresh}
              disabled={!target}
            />
            <ReviewedAction
              title={t('remove')}
              variant="sell"
              description={t('removeBody')}
              review={<p>{t('removeReview', { who: member.userId })}</p>}
              perform={() => portal.removeMember(member.memberId!)}
              onConfirmed={refresh}
            />
          </div>
        ) : (
          <small className="muted">
            {member.status === 'removed'
              ? t('noActionsRemoved')
              : actions.reason === 'owner'
                ? t('whyOwner')
                : actions.reason === 'admin'
                  ? t('whyAdmin')
                  : t('whyRole')}
          </small>
        )}
      </td>
    </tr>
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
  useUnsavedForm(Boolean(userId || label), c.t('draftWarning'));
  return (
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
        <ReviewedAction
          title={t('sendInvite')}
          variant="primary"
          description={t('sendInviteBody')}
          review={<p>{t('inviteReview', { who: userId.trim(), role: t(`role_${chosen}` as 'role_owner') })}</p>}
          perform={() => portal.invite({ userId: userId.trim(), role: chosen, ...(label.trim() ? { label: label.trim() } : {}) })}
          onConfirmed={() => {
            setUserId('');
            setLabel('');
            refresh();
          }}
          disabled={blocked || userId.trim().length === 0}
        />
        {blocked && <p className="muted pp-note">{t('whyRole')}</p>}
      </div>
    </PaySection>
  );
}
