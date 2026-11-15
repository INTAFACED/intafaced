import { useRef, useState, type ReactNode } from 'react';
import { DEVELOPER_ROLES, type DeveloperRole, type DeveloperTeam } from '@intafaced/contracts/api-keys';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { apiKeysCopy as copy, type ApiKeysPlainKey } from './api-keys-copy';
import { RevokeSheet, stateOf, RevokedReason, type Sheet } from './ApiKeys';
import { changeRefusal, developerRoleRequestId, readDeveloperTeam, readMyOrgs, revokeOrgKey, setDeveloperRole } from './developer-keys-api';

const ROLE_REFUSALS = new Set([
  'identity.developer_roles_unset',
  'identity.developer_role_denied',
  'identity.developer_role_unknown',
  'identity.developer_member_unknown',
  'identity.developer_request_conflict',
]);

/** One member's developer role, which only the owner can change; the service refuses anyone else. */
function RoleRow({ team, member, onSaved }: { team: DeveloperTeam; member: DeveloperTeam['members'][number]; onSaved: () => void }) {
  const { t } = copy.useCopy();
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<ApiKeysPlainKey | null>(null);
  const owner = member.orgRole === 'admin';
  const unset = team.rolesPublished === null;
  async function save(form: HTMLFormElement) {
    if (busy) return;
    const raw = String(new FormData(form).get('role') ?? '');
    const role = (DEVELOPER_ROLES as readonly string[]).includes(raw) ? (raw as DeveloperRole) : null;
    setBusy(true);
    setSaid(null);
    try {
      const answer = await setDeveloperRole(
        api,
        team.orgId,
        member.userId,
        role,
        developerRoleRequestId(team.orgId, member.userId, member.roleVersion, role),
      );
      if (answer.ok) {
        // The area reads the team again; the saved notice is the area's, so it outlives the reload.
        onSaved();
      } else if (answer.code && ROLE_REFUSALS.has(answer.code)) {
        setSaid(`roleRefused.${answer.code}` as ApiKeysPlainKey);
      } else {
        setSaid('roleUncertain');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <tr data-member-id={member.userId}>
      <th scope="row">
        <bdi lang="und">{member.email}</bdi>
      </th>
      <td>
        {owner ? (
          t('roleOwner')
        ) : (
          <form
            className="api-keys__role"
            onSubmit={(event) => {
              event.preventDefault();
              void save(event.currentTarget);
            }}
          >
            <select
              name="role"
              aria-label={t('colRole')}
              defaultValue={member.developerRole ?? ''}
              disabled={unset || busy}
              data-testid="api-keys__role-select"
            >
              <option value="">{t('roleNone')}</option>
              {(team.rolesPublished ?? []).map((role) => (
                <option key={role} value={role}>
                  {t(`role.${role}`)}
                </option>
              ))}
            </select>{' '}
            <Button type="submit" variant="secondary" disabled={unset || busy}>
              {t('roleSave')}
            </Button>
            {said && (
              <p role="alert" className="error-text">
                {t(said)}
              </p>
            )}
          </form>
        )}
      </td>
    </tr>
  );
}

/**
 * One organisation's developer area on the key page (DV-console-01, J-developer-15 #4): the person's developer role,
 * the organisation's keys, and Create and Revoke, disabled with the reason when the role does not allow them. With
 * roles not published the section says `roles not set`. The owner sees every member and changes their role.
 */
function OrgArea({ orgId, at }: { orgId: string; at: (iso: string) => ReactNode }) {
  const { t } = copy.useCopy();
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readDeveloperTeam(api, orgId, signal), `developer-team:${userId}:${orgId}`);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [notice, setNotice] = useState<ApiKeysPlainKey | null>(null);
  const sending = useRef(false);
  const now = Date.now();
  if (resource.status === 'loading') return <Loading label={t('orgLoading')} />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const team = resource.data;
  const reasonId = `org-manage-${orgId}`;
  const refusal = team.manageRefusal;
  const roleKey = team.myRole ? (`orgRole.${team.myRole}` as const) : ('orgRole.none' as const);

  async function revoke(reason: string) {
    if (!sheet || sending.current) return;
    sending.current = true;
    const target = sheet.key;
    setSheet({ ...sheet, busy: true, refusal: null, failure: null });
    try {
      const answer = await revokeOrgKey(api, orgId, target.id, reason);
      if (answer.ok) {
        setSheet(null);
        setNotice('orgRevokeDone');
        reload();
        return;
      }
      const named = changeRefusal(answer);
      setSheet({ key: target, busy: false, refusal: named, failure: named ? null : answer });
    } finally {
      sending.current = false;
    }
  }

  return (
    <section data-testid="api-keys__org" data-org-id={orgId} className="security__card" aria-labelledby={`org-${orgId}`}>
      <h2 id={`org-${orgId}`}>{t('orgTitle', { org: team.orgName })}</h2>
      <p className="muted">{t('orgIntro')}</p>
      {team.rolesPublished === null && (
        <p data-testid="api-keys__roles-unset" role="status">
          {t('rolesNotSet')}
        </p>
      )}
      <p data-testid="api-keys__my-role">
        {t('orgMyRole')}: {t(roleKey)}
      </p>
      {refusal && (
        <p id={reasonId} data-testid="api-keys__manage-reason" role="status">
          {t(`manage.${refusal}`)}
        </p>
      )}
      {refusal ? (
        <Button variant="primary" disabled aria-describedby={reasonId} data-testid="api-keys__org-create">
          {t('orgCreate')}
        </Button>
      ) : (
        <a className="button button--primary" href={`/uc/safe/api-keys/new?org=${orgId}`} data-testid="api-keys__org-create">
          {t('orgCreate')}
        </a>
      )}
      {notice && <p role="status">{t(notice)}</p>}
      {team.keys.length === 0 ? (
        <p role="status">{t('orgEmpty')}</p>
      ) : (
        <div className="api-keys__table-wrap">
          <table data-testid="api-keys__org-table" className="api-keys__table">
            <thead>
              <tr>
                <th scope="col">{t('colName')}</th>
                <th scope="col">{t('colPrefix')}</th>
                <th scope="col">{t('colScopes')}</th>
                <th scope="col">{t('colCreated')}</th>
                <th scope="col">{t('colState')}</th>
                <th scope="col">{t('colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {team.keys.map((key) => {
                const state = stateOf(key, now);
                return (
                  <tr key={key.id} data-key-id={key.id}>
                    <th scope="row">
                      <bdi lang="und">{key.name}</bdi>
                    </th>
                    <td>
                      <code lang="und">{key.prefix}</code>
                    </td>
                    <td>
                      <bdi lang="und">{key.scopes.join(', ')}</bdi>
                    </td>
                    <td>{at(key.createdAt)}</td>
                    <td>{state === 'stateRevoked' ? <RevokedReason apiKey={key} /> : t(state)}</td>
                    <td className="api-keys__row-action">
                      {!key.revoked && (
                        <Button
                          variant="secondary"
                          disabled={refusal !== null || sheet !== null}
                          aria-describedby={refusal ? reasonId : undefined}
                          onClick={() => {
                            setNotice(null);
                            setSheet({ key, busy: false, refusal: null, failure: null });
                          }}
                        >
                          {t('revoke')}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {team.myRole === 'owner' && (
        <>
          <h3>{t('teamTitle')}</h3>
          <div className="api-keys__table-wrap">
            <table data-testid="api-keys__team" className="api-keys__table">
              <thead>
                <tr>
                  <th scope="col">{t('colMember')}</th>
                  <th scope="col">{t('colRole')}</th>
                </tr>
              </thead>
              <tbody>
                {team.members.map((member) => (
                  <RoleRow
                    key={member.userId}
                    team={team}
                    member={member}
                    onSaved={() => {
                      setNotice('roleSaved');
                      reload();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {sheet && <RevokeSheet sheet={sheet} onClose={() => !sheet.busy && setSheet(null)} onSubmit={(reason) => void revoke(reason)} />}
    </section>
  );
}

/**
 * The developer areas of the organisations the person belongs to. A person in no organisation has no organisation keys,
 * and nothing is shown for them; their own keys are the list above.
 */
export function OrgKeys({ at }: { at: (iso: string) => ReactNode }) {
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readMyOrgs(api, signal), `my-orgs:${userId}`);
  if (resource.status === 'loading') return null;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return (
    <>
      {resource.data.orgs.map((org) => (
        <OrgArea key={org.id} orgId={org.id} at={at} />
      ))}
    </>
  );
}
