// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyRecord, DeveloperTeam } from '@intafaced/contracts/api-keys';

// TEST data only. The key page's organisation area (DV-console-01, J-developer-15 #4): a read-role member sees Create
// and Revoke disabled with the reason; with roles not published it says roles not set; the owner changes a role.
const USER = '12345678-1234-4234-8234-123456789abc';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const world = vi.hoisted(() => ({
  queries: {} as Record<string, unknown[]>,
  mutate: [] as unknown[],
  asked: [] as Array<{ kind: string; procedure: string; input: unknown }>,
}));
const api = {
  query: (_service: string, procedure: string, input: unknown) => {
    world.asked.push({ kind: 'query', procedure, input });
    const queue = world.queries[procedure] ?? [];
    return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
  },
  mutate: (_service: string, procedure: string, input: unknown) => {
    world.asked.push({ kind: 'mutate', procedure, input });
    return Promise.resolve(world.mutate.shift());
  },
};
vi.mock('../session/session', () => ({ useSession: () => ({ userId: USER, api }) }));

import { OrgKeys } from './OrgKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;

const key: ApiKeyRecord = {
  id: '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d',
  name: 'org-reader',
  prefix: 'ifc_ab12cd',
  mode: 'live',
  scopes: ['trade:read'],
  ipAllowlist: [],
  requireSignature: false,
  createdAt: '2026-11-09T10:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
  revoked: false,
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  accountId: null,
  kind: 'personal',
};
const team = (over: Partial<DeveloperTeam>): { ok: true; data: DeveloperTeam } => ({
  ok: true,
  data: {
    orgId: ORG,
    orgName: 'Acme TEST',
    rolesPublished: ['keys_admin', 'keys_read'],
    myRole: 'keys_read',
    manageRefusal: 'identity.developer_role_read_only',
    members: [],
    keys: [key],
    ...over,
  },
});
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
async function render() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<OrgKeys at={(iso) => iso} />));
  for (let i = 0; i < 5; i += 1) await settle();
}
const button = (pattern: RegExp) => [...host.querySelectorAll('button')].find((b) => pattern.test(b.textContent ?? ''));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.queries = { listOrgs: [{ ok: true, data: { orgs: [{ id: ORG, name: 'Acme TEST', role: 'trader' }] } }] };
  world.mutate = [];
  world.asked = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('the organisation area on the key page', () => {
  it('a read-role member sees the keys with Create and Revoke disabled and the reason', async () => {
    world.queries['developerKeys.team'] = [team({})];
    await render();
    const reason = host.querySelector('[data-testid="api-keys__manage-reason"]');
    expect(reason?.textContent).toBe('You can’t create or revoke keys here: your role only reads keys.');
    const create = host.querySelector<HTMLButtonElement>('button[data-testid="api-keys__org-create"]');
    expect(create?.disabled).toBe(true);
    expect(create?.getAttribute('aria-describedby')).toBe(reason?.id);
    const revoke = button(/^Revoke$/);
    expect(revoke?.disabled).toBe(true);
    expect(revoke?.getAttribute('aria-describedby')).toBe(reason?.id);
    expect(host.querySelector('[data-testid="api-keys__team"]')).toBeNull();
  });

  it('with roles not published the area says roles not set', async () => {
    world.queries['developerKeys.team'] = [
      team({ rolesPublished: null, myRole: null, manageRefusal: 'identity.developer_roles_unset', keys: [] }),
    ];
    await render();
    expect(host.querySelector('[data-testid="api-keys__roles-unset"]')?.textContent).toContain('Roles not set');
    expect(host.querySelector<HTMLButtonElement>('button[data-testid="api-keys__org-create"]')?.disabled).toBe(true);
  });

  it('the owner has Create as a link and changes a member’s role', async () => {
    world.queries['developerKeys.team'] = [
      team({
        myRole: 'owner',
        manageRefusal: null,
        members: [
          { userId: USER, email: 'owner@example.test', orgRole: 'admin', developerRole: null, roleVersion: 0 },
          { userId: MEMBER, email: 'member@example.test', orgRole: 'trader', developerRole: 'keys_read', roleVersion: 1 },
        ],
      }),
    ];
    world.mutate = [{ ok: true, data: { userId: MEMBER, role: 'keys_admin', changed: true } }];
    await render();
    expect(host.querySelector('a[data-testid="api-keys__org-create"]')?.getAttribute('href')).toBe(`/uc/safe/api-keys/new?org=${ORG}`);
    expect(button(/^Revoke$/)?.disabled).toBe(false);
    const row = host.querySelector(`[data-member-id="${MEMBER}"]`)!;
    const select = row.querySelector('select')!;
    select.value = 'keys_admin';
    await act(async () => row.querySelector('form')!.requestSubmit());
    await settle();
    const sent = world.asked.find((a) => a.procedure === 'developerKeys.setTeamRole');
    expect(sent?.input).toMatchObject({ orgId: ORG, userId: MEMBER, role: 'keys_admin' });
    // The request id is a business key (AGENTS.md floor 3): organisation, member, the role version seen, the role asked.
    expect((sent?.input as { requestId: string }).requestId).toBe(`dev-role:${ORG}:${MEMBER}:v1:keys_admin`);
    for (let i = 0; i < 5; i += 1) await settle();
    expect(host.textContent).toContain('The role is saved.');
  });

  it('a person in no organisation sees no organisation area', async () => {
    world.queries.listOrgs = [{ ok: true, data: { orgs: [] } }];
    await render();
    expect(host.querySelector('[data-testid="api-keys__org"]')).toBeNull();
  });
});
