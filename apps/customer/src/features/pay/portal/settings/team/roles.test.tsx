import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { permissionCatalogueSchema, type PermissionCatalogue } from '../../schemas';
import { failed, ready } from '../account/testing';
import { portalCopy } from '../copy';
import { permissionName, RolesCatalogue } from './Roles';
import { catalogue as standIn } from '../../mock/core.mjs';

const source = fileURLToPath(
  new URL('../../../../../../../../services/svc-pay/src/merchant-ops/merchant-plat-org-permission-catalogue.ts', import.meta.url),
);
const html = (catalogue: Parameters<typeof RolesCatalogue>[0]['catalogue']) =>
  renderToString(<RolesCatalogue catalogue={catalogue} retry={() => {}} />);
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
const t = portalCopy.t;

describe('the roles page shows the service’s own catalogue (M-plat-org-03)', () => {
  const real = async (): Promise<PermissionCatalogue> => {
    const mod = (await import(/* @vite-ignore */ source)) as { permissionCatalogue: () => unknown };
    return permissionCatalogueSchema.parse(mod.permissionCatalogue());
  };

  it('parses what the service sends, with all five built-in roles', async () => {
    const catalogue = await real();
    expect(catalogue.roles.map((r) => r.role)).toEqual(['owner', 'admin', 'finance', 'developer', 'viewer']);
  }, 30_000);

  it('names every permission the service has, and each role’s description is the service’s', async () => {
    const catalogue = await real();
    const page = text(html(ready(catalogue)));
    for (const role of catalogue.roles) expect(page).toContain(role.description);
    for (const group of catalogue.areas)
      for (const perm of group.permissions) {
        expect(permissionName(perm.key, t), perm.key).not.toContain(perm.key);
        expect(page).toContain(permissionName(perm.key, t));
      }
  }, 30_000);

  it('the stand-in backend grants each role exactly what the service does', async () => {
    const real = (await import(/* @vite-ignore */ source)) as { permissionCatalogue: () => PermissionCatalogue };
    const grants = (c: PermissionCatalogue) => Object.fromEntries(c.roles.map((r) => [r.role, [...r.grants].sort()]));
    const areas = (c: PermissionCatalogue) => c.areas.flatMap((g) => g.permissions.map((p) => `${g.area}:${p.key}`)).sort();
    const mock = standIn() as PermissionCatalogue;
    expect(grants(mock)).toEqual(grants(real.permissionCatalogue()));
    expect(areas(mock)).toEqual(areas(real.permissionCatalogue()));
  }, 30_000);

  it('marks each cell from heldBy, so a role holds on the page exactly what it holds on the server', async () => {
    const catalogue = await real();
    const markup = html(ready(catalogue));
    const roles = ['owner', 'admin', 'finance', 'developer', 'viewer'] as const;
    for (const group of catalogue.areas)
      for (const perm of group.permissions) {
        const name = permissionName(perm.key, t);
        const start = markup.indexOf(`<th scope="row">${name}`);
        expect(start, perm.key).toBeGreaterThan(-1);
        const row = markup.slice(start, markup.indexOf('</tr>', start));
        const cells = [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);
        expect(cells, perm.key).toEqual(roles.map((r) => (perm.heldBy.includes(r) ? t('held') : t('notHeld'))));
      }
  }, 30_000);
});

describe('the roles page when the catalogue is not there', () => {
  it('says why and offers a retry instead of a guessed table', () => {
    const page = html(failed('pay.merchant_ops_not_merchant', 403));
    expect(page).not.toContain(t('held'));
    expect(page).toContain(t('rolesTitle'));
  });

  it('shows a key or an area it has no name for, rather than hiding it', () => {
    const catalogue: PermissionCatalogue = {
      roles: [],
      areas: [
        {
          area: 'compliance',
          permissions: [{ key: 'team.audit', area: 'compliance', kind: 'read', requires: [], heldBy: ['owner'], unheld: false }],
        },
      ],
    };
    const page = text(html(ready(catalogue)));
    expect(page).toContain('team.audit');
    expect(page).toContain('compliance');
  });
});
