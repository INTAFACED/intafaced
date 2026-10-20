import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase } from '@intafaced/db';
import { migrateOutreach } from '../db/migrate.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { createMemoryComplianceStore, createPgComplianceStore, type ComplianceStore } from './store.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '33333333-3333-4333-8333-333333333333';
const CARL = '44444444-4444-4444-8444-444444444444';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

function principal(userId: string, overrides: Partial<Principal> = {}): Principal {
  return {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:compliance', 'admin:write'],
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

async function signed(p: Principal) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

const NOW = '2026-10-20T12:00:00.000Z';
async function api(store: ComplianceStore | undefined, p: Principal) {
  return createOpsRouter(new OpsService(), undefined, { now: () => NOW, ...(store ? { compliance: store } : {}) }).createCaller(
    await signed(p),
  );
}

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();

function suite(name: string, open: () => Promise<{ store: ComplianceStore; close: () => Promise<void> }>) {
  describe(name, () => {
    const withStore = async (run: (store: ComplianceStore) => Promise<void>) => {
      const { store, close } = await open();
      try {
        await run(store);
      } finally {
        await close();
      }
    };

    it('shows an operator only the inboxes they belong to, and the access panel names the owner of the rest', () =>
      withStore(async (store) => {
        const alice = await api(store, principal(ALICE));
        const one = await alice.compliance.inboxes.define({
          name: 'screening',
          version: 1,
          entityType: 'user',
          workflow: 'standard',
          members: [BOB],
        });
        const two = await alice.compliance.inboxes.define({
          name: 'kyc',
          version: 1,
          entityType: 'user',
          workflow: 'standard',
          members: [BOB],
        });
        const three = await alice.compliance.inboxes.define({ name: 'secret', version: 1, entityType: 'user', workflow: 'standard' });
        const bob = await api(store, principal(BOB));
        const listed = await bob.compliance.inboxes.list();
        expect(listed.inboxes.map((e) => e.inbox.id).sort()).toEqual([one.id, two.id].sort());
        expect(JSON.stringify(listed)).not.toContain(BOB + '"]');
        await expect(bob.compliance.cases.list({ inboxId: three.id, limit: 5 })).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: expect.stringContaining(`compliance.inbox_forbidden`),
        });
        await expect(bob.compliance.cases.list({ inboxId: three.id, limit: 5 })).rejects.toMatchObject({
          message: expect.stringContaining(ALICE),
        });
        expect(await bob.compliance.inboxes.access({ inboxId: three.id })).toMatchObject({ owner: ALICE, member: false });
      }));

    it('stores a queue definition once per name and version, and refuses a different body under the same key', () =>
      withStore(async (store) => {
        const alice = await api(store, principal(ALICE));
        const input = { name: 'screening', version: 1, entityType: 'user', workflow: 'standard', members: [BOB] };
        const first = await alice.compliance.inboxes.define(input);
        expect(await alice.compliance.inboxes.define(input)).toEqual(first);
        await expect(alice.compliance.inboxes.define({ ...input, entityType: 'account' })).rejects.toMatchObject({
          message: expect.stringContaining('compliance.queue_name_taken'),
        });
        const v2 = await alice.compliance.inboxes.define({ ...input, version: 2, entityType: 'account' });
        expect(v2.id).not.toBe(first.id);
      }));

    it('refuses an unknown entity type and stores nothing', () =>
      withStore(async (store) => {
        const alice = await api(store, principal(ALICE));
        await expect(
          alice.compliance.inboxes.define({ name: 'odd', version: 1, entityType: 'spaceship', workflow: 'standard' }),
        ).rejects.toMatchObject({ message: expect.stringContaining('compliance.queue_entity_unknown') });
        expect((await alice.compliance.inboxes.list()).inboxes).toEqual([]);
      }));

    it('needs a second factor to define a queue', () =>
      withStore(async (store) => {
        const noMfa = await api(store, principal(ALICE, { mfa: false }));
        await expect(
          noMfa.compliance.inboxes.define({ name: 'q', version: 1, entityType: 'user', workflow: 'standard' }),
        ).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        const reader = await api(store, principal(ALICE, { scopes: ['admin:read'] }));
        await expect(reader.compliance.inboxes.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }));

    it('lists 120 cases filtered, paged and counted by the service', () =>
      withStore(async (store) => {
        const alice = await api(store, principal(ALICE));
        const inbox = await alice.compliance.inboxes.define({ name: 'screening', version: 1, entityType: 'user', workflow: 'standard' });
        for (let i = 0; i < 120; i++) {
          await alice.compliance.cases.open({
            id: `case-${String(i).padStart(3, '0')}`,
            inboxId: inbox.id,
            kind: 'screening_hit',
            subjectId: `u${i}`,
            openedAt: at(i),
          });
        }
        const all = await alice.compliance.cases.list({ inboxId: inbox.id, limit: 50, groupByReviewLevel: true });
        expect(all.total).toBe(120);
        expect(all.rows).toHaveLength(50);
        expect(all.rows[0]?.id).toBe('case-119');
        expect(all.groups).toEqual({ green: 0, yellow: 0, red: 0, unset: 120 });
        const second = await alice.compliance.cases.list({ inboxId: inbox.id, limit: 50, cursor: all.nextCursor ?? '' });
        expect(second.rows[0]?.id).toBe('case-069');
        expect(second.groups).toBeNull();
        const third = await alice.compliance.cases.list({ inboxId: inbox.id, limit: 50, cursor: second.nextCursor ?? '' });
        expect(third.rows).toHaveLength(20);
        expect(third.nextCursor).toBeNull();
        expect(
          (await alice.compliance.cases.list({ inboxId: inbox.id, limit: 5, filter: { reviewLevels: ['red'], unassignedOnly: true } }))
            .total,
        ).toBe(0);
        expect((await alice.compliance.cases.list({ inboxId: inbox.id, limit: 5, filter: { createdFrom: at(100) } })).total).toBe(20);
        expect((await alice.compliance.cases.list({ inboxId: inbox.id, limit: 5, filter: { closedOnly: true } })).total).toBe(0);
      }));

    it('refuses a list with no page size, instead of inventing one', () =>
      withStore(async (store) => {
        const alice = await api(store, principal(ALICE));
        const inbox = await alice.compliance.inboxes.define({ name: 'screening', version: 1, entityType: 'user', workflow: 'standard' });
        await expect(alice.compliance.cases.list({ inboxId: inbox.id })).rejects.toMatchObject({
          message: expect.stringContaining('compliance.cases_list_limit_unset'),
        });
      }));

    it('stores a case once, opens by id, and says not found by typed code', () =>
      withStore(async (store) => {
        const alice = await api(store, principal(ALICE));
        const inbox = await alice.compliance.inboxes.define({ name: 'screening', version: 1, entityType: 'user', workflow: 'standard' });
        const input = { id: 'case-1', inboxId: inbox.id, kind: 'manual' as const, subjectId: 'u1', openedAt: at(1) };
        const first = await alice.compliance.cases.open(input);
        expect(first.created).toBe(true);
        expect(first.case).toMatchObject({ status: 'pending', reviewLevel: null, assignee: null, dueAt: null, entityType: 'user' });
        const again = await alice.compliance.cases.open({ ...input, openedAt: at(9) });
        expect(again).toEqual({ case: first.case, created: false });
        expect(await alice.compliance.cases.getById({ id: 'case-1' })).toEqual(first.case);
        await expect(alice.compliance.cases.getById({ id: 'nope' })).rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: expect.stringContaining('compliance.case_not_found'),
        });
        await expect(alice.compliance.cases.open({ ...input, id: 'case-2', inboxId: 'missing' })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
        expect((await alice.compliance.cases.list({ inboxId: inbox.id, limit: 5 })).total).toBe(1);
      }));

    it('does not let a non-member open into an inbox, or read a case in another inbox through a replay', () =>
      withStore(async (store) => {
        const alice = await api(store, principal(ALICE));
        const y = await alice.compliance.inboxes.define({ name: 'y', version: 1, entityType: 'user', workflow: 'standard' });
        const x = await alice.compliance.inboxes.define({
          name: 'x',
          version: 1,
          entityType: 'user',
          workflow: 'standard',
          members: [BOB],
        });
        await alice.compliance.cases.open({ id: 'case-y', inboxId: y.id, kind: 'manual', subjectId: 'u1', openedAt: at(1) });
        const bob = await api(store, principal(BOB));
        await expect(bob.compliance.cases.open({ id: 'case-y', inboxId: y.id, kind: 'manual', subjectId: 'u1' })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(bob.compliance.cases.open({ id: 'case-y', inboxId: x.id, kind: 'manual', subjectId: 'u1' })).rejects.toMatchObject({
          code: 'CONFLICT',
          message: expect.stringContaining('compliance.case_already_open'),
        });
      }));

    it('gives the next unassigned case in stable order, and an empty answer when there is none', () =>
      withStore(async (store) => {
        const alice = await api(store, principal(ALICE));
        const inbox = await alice.compliance.inboxes.define({ name: 'screening', version: 1, entityType: 'user', workflow: 'standard' });
        expect(await alice.compliance.cases.next({ inboxId: inbox.id })).toEqual({ case: null });
        await alice.compliance.cases.open({ id: 'b', inboxId: inbox.id, kind: 'manual', subjectId: 'u', openedAt: at(2) });
        await alice.compliance.cases.open({ id: 'a', inboxId: inbox.id, kind: 'manual', subjectId: 'u', openedAt: at(1) });
        expect((await alice.compliance.cases.next({ inboxId: inbox.id })).case?.id).toBe('a');
      }));

    it('keeps the favourite per operator', () =>
      withStore(async (store) => {
        const alice = await api(store, principal(ALICE));
        const inbox = await alice.compliance.inboxes.define({
          name: 'screening',
          version: 1,
          entityType: 'user',
          workflow: 'standard',
          members: [BOB],
        });
        await alice.compliance.inboxes.setFavourite({ inboxId: inbox.id, favourite: true });
        const bob = await api(store, principal(BOB));
        expect((await alice.compliance.inboxes.list()).inboxes[0]?.favourite).toBe(true);
        expect((await bob.compliance.inboxes.list()).inboxes[0]?.favourite).toBe(false);
        const carl = await api(store, principal(CARL));
        await expect(carl.compliance.inboxes.setFavourite({ inboxId: inbox.id, favourite: true })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }));
  });
}

describe('compliance without storage', () => {
  it('refuses every call by name and lists nothing', async () => {
    const alice = await api(undefined, principal(ALICE));
    await expect(alice.compliance.inboxes.list()).rejects.toMatchObject({
      message: expect.stringContaining('ops.compliance_storage_unconfigured'),
    });
  });
});

suite('compliance over the memory store', async () => ({ store: createMemoryComplianceStore(), close: async () => undefined }));

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('compliance on real PostgreSQL', () => {
  const open = async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 6, onnotice: () => undefined });
    await migrateOutreach(sql);
    return {
      store: createPgComplianceStore(sql),
      close: async () => {
        await sql.end();
        await database.drop();
      },
    };
  };
  suite('compliance over the PostgreSQL store', open);

  it('keeps cases across a restart, writes the case event and the outbox row, and never edits the event log', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
    try {
      await migrateOutreach(sql);
      const alice = await api(createPgComplianceStore(sql), principal(ALICE));
      const inbox = await alice.compliance.inboxes.define({ name: 'screening', version: 1, entityType: 'user', workflow: 'standard' });
      const opened = await alice.compliance.cases.open({
        id: 'case-1',
        inboxId: inbox.id,
        kind: 'manual',
        subjectId: 'u1',
        openedAt: at(1),
      });
      await Promise.all(
        [1, 2, 3].map(() =>
          alice.compliance.cases.open({ id: 'case-1', inboxId: inbox.id, kind: 'manual', subjectId: 'u1', openedAt: at(1) }),
        ),
      );
      const restarted = await api(createPgComplianceStore(sql), principal(ALICE));
      expect(await restarted.compliance.cases.getById({ id: 'case-1' })).toEqual(opened.case);
      const events = await sql`SELECT action FROM ops.compliance_case_events WHERE case_id='case-1'`;
      expect(events.map((e) => e.action)).toEqual(['opened']);
      const outbox = await sql`SELECT event, idempotency_key FROM ops.compliance_outbox ORDER BY id`;
      expect(outbox.map((o) => o.idempotency_key)).toEqual(['compliance:queue:screening:1', 'compliance:case:case-1']);
      await expect(sql`UPDATE ops.compliance_case_events SET actor='x'`).rejects.toThrow(/compliance_case_event_immutable/);
    } finally {
      await sql.end();
      await database.drop();
    }
  });
});
