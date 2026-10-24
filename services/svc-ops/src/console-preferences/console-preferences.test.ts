import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, UNSET_PREFERENCES } from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { MemoryPreferenceStore, SqlPreferenceStore, type PreferenceStore } from './store.js';

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

function build(store: PreferenceStore | null = new MemoryPreferenceStore()) {
  const router = createOpsRouter(new OpsService(), undefined, { now: () => NOW, ...(store ? { preferences: store } : {}) });
  return {
    store,
    as: (userId = A, scopes = ['admin:read', 'admin:write']) => signed(userId, scopes).then((ctx) => router.createCaller(ctx)),
  };
}

const values = (over: Partial<typeof UNSET_PREFERENCES>) => ({ ...UNSET_PREFERENCES, ...over });

describe('console preferences', () => {
  it('with nothing set, every preference is the server’s; the team level names its blocker', async () => {
    const { as } = build();
    const prefs = await (await as()).preferences.get();
    expect(prefs.effective).toEqual({
      theme: { value: 'dark', from: 'server' },
      homePage: { value: '/crm', from: 'server' },
      timeZone: { value: 'UTC', from: 'server' },
      weekStart: { value: 'monday', from: 'server' },
    });
    expect(prefs.levels.team).toEqual({ values: UNSET_PREFERENCES, blocker: 'ops.preferences_team_unassigned' });
    expect(prefs.levels.organisation.updatedAt).toBeNull();
  });

  it('the most specific level wins, key by key, and clearing a key passes it back down', async () => {
    const { as, store } = build();
    const a = await as();
    await a.preferences.set({
      level: 'organisation',
      expectedRevision: 0,
      values: values({ timeZone: 'Europe/Berlin', weekStart: 'sunday' }),
    });
    const mine = await a.preferences.set({
      level: 'person',
      expectedRevision: 0,
      values: values({ timeZone: 'Asia/Dubai', homePage: '/ledger' }),
    });
    expect(mine.effective).toEqual({
      theme: { value: 'dark', from: 'server' },
      homePage: { value: '/ledger', from: 'person' },
      timeZone: { value: 'Asia/Dubai', from: 'person' },
      weekStart: { value: 'sunday', from: 'organisation' },
    });
    // Another founder sees the organisation's values, never A's own.
    expect((await (await as(B)).preferences.get()).effective.timeZone).toEqual({ value: 'Europe/Berlin', from: 'organisation' });
    const cleared = await a.preferences.set({ level: 'person', expectedRevision: 1, values: values({ homePage: '/ledger' }) });
    expect(cleared.effective.timeZone).toEqual({ value: 'Europe/Berlin', from: 'organisation' });
    expect((store as MemoryPreferenceStore).log.map((l) => `${l.ref.level}:${l.ref.subject}`)).toEqual([
      'organisation:',
      `person:${A}`,
      `person:${A}`,
    ]);
  });

  it('a save from an old read is refused, so another founder’s change is never overwritten unseen', async () => {
    const { as } = build();
    const a = await as();
    const b = await as(B);
    const read = (await a.preferences.get()).levels.organisation.revision;
    await b.preferences.set({ level: 'organisation', expectedRevision: read, values: values({ weekStart: 'sunday' }) });
    await expect(
      a.preferences.set({ level: 'organisation', expectedRevision: read, values: values({ timeZone: 'Europe/Berlin' }) }),
    ).rejects.toThrow(/ops\.preferences_stale/);
    expect((await a.preferences.get()).levels.organisation).toMatchObject({ revision: 1, values: { weekStart: 'sunday', timeZone: null } });
  });

  it('a value the console does not take is refused by name, and nothing is stored', async () => {
    const { as, store } = build();
    const a = await as();
    await expect(a.preferences.set({ level: 'person', expectedRevision: 0, values: values({ timeZone: 'Mars/Olympus' }) })).rejects.toThrow(
      /ops\.preference_invalid — .*timeZone/,
    );
    await expect(a.preferences.set({ level: 'person', expectedRevision: 0, values: values({ theme: 'light' }) })).rejects.toThrow(
      /ops\.preference_invalid/,
    );
    await expect(
      a.preferences.set({ level: 'person', expectedRevision: 0, values: values({ homePage: '//evil.example' }) }),
    ).rejects.toThrow(/ops\.preference_invalid/);
    await expect(a.preferences.set({ level: 'team', expectedRevision: 0, values: values({ timeZone: 'UTC' }) })).rejects.toThrow(
      /ops\.preferences_team_unassigned/,
    );
    expect((store as MemoryPreferenceStore).log).toHaveLength(0);
  });

  it('reads need admin:read and writes admin:write; with no storage it says so', async () => {
    const { as } = build();
    await expect(
      (await as(A, ['admin:read'])).preferences.set({ level: 'person', expectedRevision: 0, values: values({}) }),
    ).rejects.toThrow();
    await expect((await as(A, ['ops:read'])).preferences.get()).rejects.toThrow();
    const none = build(null);
    await expect((await none.as()).preferences.get()).rejects.toThrow(/ops\.preferences_storage_unconfigured/);
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('console preferences on real PostgreSQL', () => {
  it('stores each level once, logs before and after, and the log is append-only', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
    try {
      await migrateOutreach(sql);
      const { as } = build(new SqlPreferenceStore(sql));
      const a = await as();
      await a.preferences.set({ level: 'organisation', expectedRevision: 0, values: values({ timeZone: 'Europe/Berlin' }) });
      await a.preferences.set({ level: 'person', expectedRevision: 0, values: values({ timeZone: 'Asia/Dubai' }) });
      await a.preferences.set({ level: 'person', expectedRevision: 1, values: values({ weekStart: 'saturday' }) });
      // Two saves from the same read: the second is refused, and the first one's values stay.
      await expect(a.preferences.set({ level: 'person', expectedRevision: 1, values: values({}) })).rejects.toThrow(
        /ops\.preferences_stale/,
      );
      const fresh = await (await build(new SqlPreferenceStore(sql)).as()).preferences.get();
      expect(fresh.effective.timeZone).toEqual({ value: 'Europe/Berlin', from: 'organisation' });
      expect(fresh.effective.weekStart).toEqual({ value: 'saturday', from: 'person' });
      const log = await sql<{ before: { timeZone: string | null } }[]>`SELECT before FROM ops.console_preference_log ORDER BY seq`;
      expect(log.map((r) => r.before.timeZone)).toEqual([null, null, 'Asia/Dubai']);
      await expect(sql`DELETE FROM ops.console_preference_log`).rejects.toThrow(/append-only/);
      await migrateOutreach(sql, 'down');
    } finally {
      await sql.end();
      await database.drop();
    }
  });
});
