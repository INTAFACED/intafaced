import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, postgresAvailable } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { MemoryServiceRecordStore, SqlServiceRecordStore, type ServiceRecordStore } from './store.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const A = '11111111-1111-4111-8111-111111111111';
const B = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-24T10:00:00.000Z';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

async function signed(userId: string, scopes: string[]) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function build(store: ServiceRecordStore | null = new MemoryServiceRecordStore()) {
  const router = createOpsRouter(new OpsService(), undefined, { now: () => NOW, ...(store ? { serviceRecords: store } : {}) });
  return {
    store,
    as: (userId = A, scopes = ['admin:read', 'admin:write']) => signed(userId, scopes).then((ctx) => router.createCaller(ctx)),
  };
}

const LEDGER = { ownerTeam: 'Core platform', dependencies: ['edge', 'identity'], runbook: 'docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md' };

describe('service records', () => {
  it('a module nobody has set reads as revision 0 with no owner; nothing is seeded', async () => {
    const { as } = build();
    const a = await as();
    expect(await a.services.get({ module: 'ledger' })).toEqual({
      record: { module: 'ledger', ownerTeam: null, dependencies: [], runbook: null, revision: 0, updatedBy: null, updatedAt: null },
      asOf: NOW,
    });
    expect((await a.services.list()).records).toEqual([]);
  });

  it('sets a record from the revision read, ordered as the registry, with the founder as the actor', async () => {
    const { as, store } = build();
    const a = await as();
    const saved = await a.services.set({ module: 'ledger', expectedRevision: 0, ...LEDGER });
    expect(saved.record).toEqual({
      module: 'ledger',
      ownerTeam: 'Core platform',
      dependencies: ['identity', 'edge'],
      runbook: 'docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md',
      revision: 1,
      updatedBy: A,
      updatedAt: NOW,
    });
    expect((await a.services.list()).records.map((r) => r.module)).toEqual(['ledger']);
    // Clearing the owner is a save like any other: blank is unset, never a guessed team.
    const cleared = await (
      await as(B)
    ).services.set({ module: 'ledger', expectedRevision: 1, ownerTeam: ' ', dependencies: [], runbook: '' });
    expect(cleared.record).toMatchObject({ ownerTeam: null, dependencies: [], runbook: null, revision: 2, updatedBy: B });
    expect((store as MemoryServiceRecordStore).log.map((l) => [l.before.ownerTeam, l.after.ownerTeam, l.actorId])).toEqual([
      [null, 'Core platform', A],
      ['Core platform', null, B],
    ]);
  });

  it('refuses an unknown module, a bad value by name, and a save from an old read', async () => {
    const { as, store } = build();
    const a = await as();
    await expect(a.services.get({ module: 'mars' })).rejects.toThrow(/ops\.service_not_found/);
    await expect(a.services.set({ module: 'mars', expectedRevision: 0, ...LEDGER })).rejects.toThrow(/ops\.service_not_found/);
    await expect(
      a.services.set({ module: 'ledger', expectedRevision: 0, ...LEDGER, runbook: 'https://evil.example/runbook.md' }),
    ).rejects.toThrow(/ops\.service_record_invalid — .*runbook/);
    await expect(a.services.set({ module: 'ledger', expectedRevision: 0, ...LEDGER, dependencies: ['ledger'] })).rejects.toThrow(
      /ops\.service_record_invalid — .*dependencies/,
    );
    await a.services.set({ module: 'ledger', expectedRevision: 0, ...LEDGER });
    await expect((await as(B)).services.set({ module: 'ledger', expectedRevision: 0, ...LEDGER, ownerTeam: 'Other' })).rejects.toThrow(
      /ops\.service_record_stale/,
    );
    expect((await a.services.get({ module: 'ledger' })).record.ownerTeam).toBe('Core platform');
    expect((store as MemoryServiceRecordStore).log).toHaveLength(1);
  });

  it('reads need admin:read and writes admin:write; with no storage it says so', async () => {
    const { as } = build();
    await expect((await as(A, ['admin:read'])).services.set({ module: 'ledger', expectedRevision: 0, ...LEDGER })).rejects.toThrow();
    await expect((await as(A, ['ops:read'])).services.get({ module: 'ledger' })).rejects.toThrow();
    const none = build(null);
    await expect((await none.as()).services.get({ module: 'ledger' })).rejects.toThrow(/ops\.service_storage_unconfigured/);
  });
});

const serviceRecordsPg = await postgresAvailable();

if (!serviceRecordsPg) {
  describe.skip('service records (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('service records on real PostgreSQL', () => {
    it('stores one record per module, refuses a stale save, logs before and after, and the log is append-only', async () => {
      const database = await createTestDatabase({ service: 'ops' });
      const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
      try {
        await migrateOutreach(sql);
        const a = await build(new SqlServiceRecordStore(sql)).as();
        await a.services.set({ module: 'ledger', expectedRevision: 0, ...LEDGER });
        await a.services.set({ module: 'ledger', expectedRevision: 1, ...LEDGER, ownerTeam: 'Ledger team' });
        await expect(a.services.set({ module: 'ledger', expectedRevision: 1, ...LEDGER })).rejects.toThrow(/ops\.service_record_stale/);
        const fresh = await build(new SqlServiceRecordStore(sql)).as();
        expect((await fresh.services.get({ module: 'ledger' })).record).toMatchObject({
          ownerTeam: 'Ledger team',
          dependencies: ['identity', 'edge'],
          runbook: 'docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md',
          revision: 2,
          updatedBy: A,
        });
        expect((await fresh.services.get({ module: 'p2p' })).record.revision).toBe(0);
        // Clearing is a save like any other: no owner, no runbook, no dependency.
        expect(
          (await fresh.services.set({ module: 'ledger', expectedRevision: 2, ownerTeam: '', dependencies: [], runbook: null })).record,
        ).toMatchObject({ ownerTeam: null, dependencies: [], runbook: null, revision: 3 });
        // A module the registry no longer names is dropped on read rather than breaking the record.
        await sql`UPDATE ops.service_records SET dependencies = ARRAY['identity', 'retired-module'] WHERE module = 'ledger'`;
        await sql`INSERT INTO ops.service_records (module, dependencies, revision, updated_by, updated_at) VALUES ('retired-module', '{}', 1, ${A}, ${NOW})`;
        expect((await fresh.services.get({ module: 'ledger' })).record.dependencies).toEqual(['identity']);
        expect((await fresh.services.list()).records.map((r) => r.module)).toEqual(['ledger']);
        const log = await sql<{ before: { ownerTeam: string | null } }[]>`SELECT before FROM ops.service_record_log ORDER BY seq`;
        expect(log.map((r) => r.before.ownerTeam)).toEqual([null, 'Core platform', 'Ledger team']);
        await expect(sql`DELETE FROM ops.service_record_log`).rejects.toThrow(/append-only/);
        // The table refuses an outside runbook link whatever the code in front of it does.
        for (const runbook of [
          'docs/runbooks/../../AGENTS.md',
          'docs/runbooks/a//b.md',
          'docs/runbooks/a/.md',
          'https://x/docs/runbooks/a.md',
        ])
          await expect(sql`UPDATE ops.service_records SET runbook = ${runbook} WHERE module = 'ledger'`).rejects.toThrow();
        await migrateOutreach(sql, 'down');
      } finally {
        await sql.end();
        await database.drop();
      }
    });
  });
}
