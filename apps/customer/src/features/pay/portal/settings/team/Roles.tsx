import type { Resource } from '../../../../../shared/resource';
import { teamRoles, type PermissionCatalogue } from '../../schemas';
import { portalCopy, settingsMessages } from '../copy';
import { Gate, Grid, Section } from '../../volt/parts';

type T = ReturnType<typeof portalCopy.useCopy>['t'];

const ROLES = ['owner', ...teamRoles] as const;

/** A permission's plain name; a key the service added before this page learnt it shows as itself, never hidden. */
export function permissionName(key: string, t: T): string {
  const id = `perm_${key.replace('.', '_')}`;
  return id in settingsMessages ? t(id as 'perm_team_read') : t('permUnknown', { key });
}

/** An area's plain name, or its key when the service added one this page has no name for. */
function areaName(area: string, t: T): string {
  const id = `area_${area}`;
  return id in settingsMessages ? t(id as 'area_team') : area;
}

/**
 * M-plat-org-03 on `/pay/team`: the five built-in roles and every permission, as `merchantOps.permissions.catalogue`
 * sends them from the service's role table. Nothing here restates a grant, so the page and the checks cannot drift.
 */
export function RolesCatalogue({ catalogue, retry }: { catalogue: Resource<PermissionCatalogue>; retry: () => void }) {
  const { t } = portalCopy.useCopy();
  const roleName = (r: string) => t(`role_${r}` as 'role_owner');
  return (
    <>
      <Section title={t('rolesTitle')} description={t('rolesBody')}>
        <Gate resource={catalogue} retry={retry} rows={5}>
          {(data) => (
            <div>
              <Grid label={t('rolesTitle')} headers={[t('colRole'), t('colCan')]}>
                {data.roles.map((r) => (
                  <tr key={r.role}>
                    <th scope="row">{roleName(r.role)}</th>
                    <td>{r.description}</td>
                  </tr>
                ))}
              </Grid>
              <p className="lt-hint">{t('ownerOnlyNote')}</p>
            </div>
          )}
        </Gate>
      </Section>

      <Section title={t('catalogueTitle')} description={t('catalogueBody')}>
        <Gate resource={catalogue} retry={retry} rows={8}>
          {(data) => (
            <div>
              {data.areas.map((group) => (
                <Grid key={group.area} label={areaName(group.area, t)} headers={[areaName(group.area, t), ...ROLES.map(roleName)]}>
                  {group.permissions.map((perm) => (
                    <tr key={perm.key} data-permission={perm.key}>
                      <th scope="row">
                        {permissionName(perm.key, t)}
                        <small className="lt-hint">
                          {' '}
                          {perm.kind === 'write' ? t('kindWrite') : t('kindRead')}
                          {perm.requires.length > 0 &&
                            ` · ${t('needsOther', { list: perm.requires.map((k) => permissionName(k, t)).join(', ') })}`}
                          {perm.unheld && ` · ${t('unheldNote')}`}
                        </small>
                      </th>
                      {ROLES.map((role) => (
                        <td key={role}>{perm.heldBy.includes(role) ? t('held') : t('notHeld')}</td>
                      ))}
                    </tr>
                  ))}
                </Grid>
              ))}
            </div>
          )}
        </Gate>
      </Section>
    </>
  );
}
