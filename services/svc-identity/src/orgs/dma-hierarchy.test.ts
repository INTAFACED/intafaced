import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORG_ROLES } from './org-service.js';
import {
  DMA_HIERARCHY_LAW_RESIDUAL,
  DMA_HIERARCHY_PRODUCTS,
  DmaHierarchyRefuseError,
  UNPUBLISHED_DMA_HIERARCHY_LAW,
  createDmaHierarchyProduct,
  dmaHierarchyLawIsPublished,
  dmaHierarchyLawStatusLine,
  parseDmaHierarchyLawJson,
  requireDmaHierarchyProduct,
} from './dma-hierarchy.js';

type OrgRow = { id: string; name: string; created_by: string };
type MemberRow = { org_id: string; user_id: string; role: string };

function store(users: string[], orgs: OrgRow[], members: MemberRow[]) {
  let writes = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').toLowerCase();
    if (text.includes('insert ') || text.includes('update ') || text.includes('delete ')) {
      writes += 1;
    }
    if (text.includes('from organizations')) {
      const id = values[0];
      return orgs.filter((o) => o.id === id).map((o) => ({ id: o.id }));
    }
    if (text.includes('from organization_members') && text.includes('role')) {
      const orgId = values[0];
      const userId = values[1];
      return members.filter((m) => m.org_id === orgId && m.user_id === userId).map((m) => ({ role: m.role }));
    }
    if (text.includes('from users')) {
      const id = values[0];
      return users.filter((u) => u === id).map((u) => ({ id: u }));
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return Object.assign(fn, {
    get writes() {
      return writes;
    },
  }) as unknown as Parameters<typeof createDmaHierarchyProduct>[0]['sql'] & { writes: number };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_A = '11111111-1111-4111-8111-111111111111';

describe('DMA hierarchy products (M01/M20)', () => {
  it('names dma-broker, desk, and shift', () => {
    expect(DMA_HIERARCHY_PRODUCTS).toEqual(['dma-broker', 'desk', 'shift']);
    expect(requireDmaHierarchyProduct('desk')).toBe('desk');
    expect(requireDmaHierarchyProduct('shift')).toBe('shift');
    expect(requireDmaHierarchyProduct('dma-broker')).toBe('dma-broker');
  });

  it('does not add broker/desk/shift as org roles', () => {
    expect(ORG_ROLES).toEqual(['admin', 'trader', 'auditor', 'risk-manager']);
    expect(ORG_ROLES).not.toContain('dma-broker');
    expect(ORG_ROLES).not.toContain('desk');
    expect(ORG_ROLES).not.toContain('shift');
    expect(ORG_ROLES).not.toContain('broker');
  });

  it('blank env → unpublished; no tree', () => {
    expect(parseDmaHierarchyLawJson(undefined)).toEqual(UNPUBLISHED_DMA_HIERARCHY_LAW);
    expect(parseDmaHierarchyLawJson('')).toEqual(UNPUBLISHED_DMA_HIERARCHY_LAW);
    expect(parseDmaHierarchyLawJson('   ')).toEqual(UNPUBLISHED_DMA_HIERARCHY_LAW);
    expect(parseDmaHierarchyLawJson('{"published":false}')).toEqual(UNPUBLISHED_DMA_HIERARCHY_LAW);
    expect(dmaHierarchyLawIsPublished(UNPUBLISHED_DMA_HIERARCHY_LAW)).toBe(false);
    expect(dmaHierarchyLawStatusLine(UNPUBLISHED_DMA_HIERARCHY_LAW)).toBe('published=0 tree=0');
  });

  it('published:true without a tree is published', () => {
    const law = parseDmaHierarchyLawJson('{"published":true}');
    expect(law).toEqual({ published: true });
    expect(dmaHierarchyLawIsPublished(law)).toBe(true);
    expect(dmaHierarchyLawStatusLine(law)).toBe('published=1 tree=0');
  });

  it('refuses an invented broker tree in owner JSON', () => {
    expect(() => parseDmaHierarchyLawJson(JSON.stringify({ published: true, brokers: [{ id: 'x' }] }))).toThrow(DmaHierarchyRefuseError);
    try {
      parseDmaHierarchyLawJson(JSON.stringify({ published: true, desks: [] }));
    } catch (err) {
      expect(err).toBeInstanceOf(DmaHierarchyRefuseError);
      expect((err as DmaHierarchyRefuseError).code).toBe('identity.dma.tree_unbuilt');
    }
  });

  it('malformed env JSON fails boot (throws), does not invent', () => {
    expect(() => parseDmaHierarchyLawJson('{not-json')).toThrow(DmaHierarchyRefuseError);
    expect(() => parseDmaHierarchyLawJson('[]')).toThrow(DmaHierarchyRefuseError);
    expect(() => parseDmaHierarchyLawJson('{"published":"yes"}')).toThrow(DmaHierarchyRefuseError);
  });

  it('creating dma-broker / desk / shift without owner law refuses typed error and writes nothing', async () => {
    const sql = store([A], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    for (const kind of DMA_HIERARCHY_PRODUCTS) {
      await expect(
        createDmaHierarchyProduct({
          sql,
          actorUserId: A,
          orgId: ORG_A,
          kind,
          law: UNPUBLISHED_DMA_HIERARCHY_LAW,
        }),
      ).rejects.toMatchObject({
        name: 'DmaHierarchyRefuseError',
        code: 'identity.dma.hierarchy_law_unset',
        residual: DMA_HIERARCHY_LAW_RESIDUAL,
      });
    }
    expect(sql.writes).toBe(0);
  });

  it('published law answers the product on the org and persists nothing (RC-identity-09 removed tree_unbuilt)', async () => {
    const sql = store([A], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    await expect(
      createDmaHierarchyProduct({
        sql,
        actorUserId: A,
        orgId: ORG_A,
        kind: 'desk',
        law: { published: true },
      }),
    ).resolves.toEqual({ orgId: ORG_A, kind: 'desk' });
    expect(sql.writes).toBe(0);
  });

  it('missing / unknown kind refuses without writing', async () => {
    const sql = store([A], [{ id: ORG_A, name: 'A', created_by: A }], [{ org_id: ORG_A, user_id: A, role: 'admin' }]);
    await expect(
      createDmaHierarchyProduct({
        sql,
        actorUserId: A,
        orgId: ORG_A,
        kind: 'broker-tree',
        law: UNPUBLISHED_DMA_HIERARCHY_LAW,
      }),
    ).rejects.toMatchObject({ code: 'identity.dma.kind_invalid' });
    await expect(
      createDmaHierarchyProduct({
        sql,
        actorUserId: A,
        orgId: ORG_A,
        kind: '',
        law: UNPUBLISHED_DMA_HIERARCHY_LAW,
      }),
    ).rejects.toMatchObject({ code: 'identity.dma.kind_required' });
    expect(sql.writes).toBe(0);
  });

  it('missing org still uses existing org refuse — never invents a home org', async () => {
    const sql = store([A], [], []);
    await expect(
      createDmaHierarchyProduct({
        sql,
        actorUserId: A,
        orgId: ORG_A,
        kind: 'desk',
        law: UNPUBLISHED_DMA_HIERARCHY_LAW,
      }),
    ).rejects.toMatchObject({ code: 'org.not_found' });
    expect(sql.writes).toBe(0);
  });

  it('env.ts sockets IDENTITY_DMA_HIERARCHY_LAW_JSON with blank default (unpublished)', () => {
    const envTs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'env.ts'), 'utf8');
    expect(envTs).toMatch(/IDENTITY_DMA_HIERARCHY_LAW_JSON:\s*z\.string\(\)\.optional\(\)\.default\(''\)/);
  });

  it('compose pass-through has no default tree', () => {
    const compose = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docker-compose.apps.yml'), 'utf8');
    expect(compose).toMatch(/IDENTITY_DMA_HIERARCHY_LAW_JSON:\s*\$\{IDENTITY_DMA_HIERARCHY_LAW_JSON:-\}/);
    expect(compose).not.toMatch(/IDENTITY_DMA_HIERARCHY_LAW_JSON:\s*\$\{IDENTITY_DMA_HIERARCHY_LAW_JSON:\?/);
  });
});
