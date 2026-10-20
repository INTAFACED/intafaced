import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase } from '@intafaced/db';
import { migrateOutreach } from '../db/migrate.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { createMemoryAlertRuleStore, createPgAlertRuleStore } from './rule-store.js';
import { AlertRules, type AlertRuleStore } from './rules.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
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

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 20, 6, 0, tick++)).toISOString();

async function api(store: AlertRuleStore | undefined, p: Principal = principal()) {
  return createOpsRouter(new OpsService(), undefined, {
    ...(store ? { alertRules: new AlertRules(store, clock) } : {}),
  }).createCaller(await signed(p));
}

const draft = {
  name: 'Ledger postings stalled',
  folder: 'ledger',
  group: 'every-minute',
  signal: 'ledger.postings.count',
  condition: { operator: 'lt' as const, threshold: '1' },
  intervalSeconds: 60,
  pendingSeconds: 120,
  labels: { owner: 'founder' },
  reason: 'first rule',
  idempotencyKey: 'alert-key-0001',
};

function suite(name: string, open: () => Promise<{ store: AlertRuleStore; close: () => Promise<void> }>) {
  describe(name, () => {
    const withStore = async (run: (store: AlertRuleStore) => Promise<void>) => {
      const { store, close } = await open();
      try {
        await run(store);
      } finally {
        await close();
      }
    };

    it('saves a rule, replays the same key to the same row and conflicts a different body', () =>
      withStore(async (store) => {
        const caller = await api(store);
        const first = await caller.alertRules.create(draft);
        expect(first).toMatchObject({ version: 1, paused: false, retiredAt: null, condition: { operator: 'lt', threshold: '1' } });
        expect(await caller.alertRules.create(draft)).toEqual(first);
        await expect(caller.alertRules.create({ ...draft, name: 'Other' })).rejects.toMatchObject({
          code: 'CONFLICT',
          message: expect.stringContaining('ops.idempotency_conflict'),
        });
        expect((await caller.alertRules.list({ limit: 10 })).rules).toHaveLength(1);
      }));

    it('refuses a blank threshold, interval and pending period by name, and an unknown signal', () =>
      withStore(async (store) => {
        const caller = await api(store);
        const blankThreshold = { ...draft, condition: { operator: 'lt' as const } };
        await expect(caller.alertRules.create(blankThreshold)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: expect.stringContaining('ops.alert_threshold_unset'),
        });
        const { intervalSeconds: _i, ...noInterval } = draft;
        await expect(caller.alertRules.create(noInterval)).rejects.toMatchObject({
          message: expect.stringContaining('ops.alert_interval_unset'),
        });
        const { pendingSeconds: _p, ...noPending } = draft;
        await expect(caller.alertRules.create(noPending)).rejects.toMatchObject({
          message: expect.stringContaining('ops.alert_interval_unset'),
        });
        await expect(caller.alertRules.create({ ...draft, signal: 'pay.mystery' })).rejects.toMatchObject({
          message: expect.stringContaining('ops.alert_signal_unknown'),
        });
        expect((await caller.alertRules.list({ limit: 10 })).rules).toEqual([]);
      }));

    it('treats a pending period of zero as a value the operator chose', () =>
      withStore(async (store) => {
        const caller = await api(store);
        expect(await caller.alertRules.create({ ...draft, pendingSeconds: 0 })).toMatchObject({ pendingSeconds: 0 });
      }));

    it('refuses two live rules with the same label set, in any key order, until one is retired', () =>
      withStore(async (store) => {
        const caller = await api(store);
        const a = await caller.alertRules.create({ ...draft, labels: { owner: 'founder', team: 'ops' } });
        await expect(
          caller.alertRules.create({
            ...draft,
            name: 'Second',
            labels: { team: 'ops', owner: 'founder' },
            idempotencyKey: 'alert-key-0002',
          }),
        ).rejects.toMatchObject({ message: expect.stringContaining('ops.alert_labels_duplicate') });
        await caller.alertRules.retire({ id: a.id, expectedVersion: 1, reason: 'replaced', idempotencyKey: 'alert-key-0003' });
        const b = await caller.alertRules.create({
          ...draft,
          name: 'Second',
          labels: { team: 'ops', owner: 'founder' },
          idempotencyKey: 'alert-key-0004',
        });
        expect(b.version).toBe(1);
      }));

    it('keeps every save as a version, refuses a stale edit and an edit of a retired rule', () =>
      withStore(async (store) => {
        const caller = await api(store);
        const v1 = await caller.alertRules.create(draft);
        const v2 = await caller.alertRules.update({
          ...draft,
          id: v1.id,
          expectedVersion: 1,
          condition: { operator: 'lt', threshold: '2' },
          reason: 'raise threshold',
          idempotencyKey: 'alert-key-0005',
        });
        expect(v2).toMatchObject({ version: 2, condition: { threshold: '2' } });
        await expect(
          caller.alertRules.update({ ...draft, id: v1.id, expectedVersion: 1, reason: 'late edit', idempotencyKey: 'alert-key-0006' }),
        ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('ops.alert_rule_version_stale') });
        const paused = await caller.alertRules.setPaused({
          id: v1.id,
          expectedVersion: 2,
          paused: true,
          reason: 'maintenance',
          idempotencyKey: 'alert-key-0007',
        });
        expect(paused).toMatchObject({ version: 3, paused: true });
        const retired = await caller.alertRules.retire({
          id: v1.id,
          expectedVersion: 3,
          reason: 'obsolete',
          idempotencyKey: 'alert-key-0008',
        });
        expect(retired.retiredAt).not.toBeNull();
        await expect(
          caller.alertRules.setPaused({ id: v1.id, expectedVersion: 4, paused: false, reason: 'x', idempotencyKey: 'alert-key-0009' }),
        ).rejects.toMatchObject({ message: expect.stringContaining('ops.alert_rule_retired') });
        const { versions } = await caller.alertRules.versions({ id: v1.id, limit: 10 });
        expect(versions.map((v) => [v.version, v.change])).toEqual([
          [4, 'retired'],
          [3, 'paused'],
          [2, 'updated'],
          [1, 'created'],
        ]);
        expect(versions[2]?.rule.condition.threshold).toBe('2');
        expect(versions[3]?.rule.condition.threshold).toBe('1');
        expect((await caller.alertRules.list({ limit: 10 })).rules).toEqual([]);
        expect((await caller.alertRules.list({ limit: 10, includeRetired: true })).rules).toHaveLength(1);
      }));

    it('lets only an admin restore a retired rule', () =>
      withStore(async (store) => {
        const operator = await api(store);
        const rule = await operator.alertRules.create(draft);
        await operator.alertRules.retire({ id: rule.id, expectedVersion: 1, reason: 'obsolete', idempotencyKey: 'alert-key-0010' });
        await expect(
          operator.alertRules.restore({ id: rule.id, expectedVersion: 2, reason: 'back', idempotencyKey: 'alert-key-0011' }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('ops.alert_forbidden') });
        const admin = await api(store, principal({ scopes: ['admin:read', 'admin:write', 'admin:treasury'] }));
        const restored = await admin.alertRules.restore({
          id: rule.id,
          expectedVersion: 2,
          reason: 'back',
          idempotencyKey: 'alert-key-0011',
        });
        expect(restored).toMatchObject({ version: 3, retiredAt: null });
        await expect(
          admin.alertRules.restore({ id: rule.id, expectedVersion: 3, reason: 'again', idempotencyKey: 'alert-key-0012' }),
        ).rejects.toMatchObject({ message: expect.stringContaining('ops.alert_rule_not_retired') });
      }));

    it('pages by keyset and filters by folder, name and label', () =>
      withStore(async (store) => {
        const caller = await api(store);
        for (const [i, folder] of ['a', 'a', 'b'].entries()) {
          await caller.alertRules.create({
            ...draft,
            name: `Rule ${i}`,
            folder,
            labels: { owner: `o${i}` },
            idempotencyKey: `alert-page-${i}0000`,
          });
        }
        const first = await caller.alertRules.list({ limit: 2 });
        expect(first.rules.map((r) => r.name)).toEqual(['Rule 0', 'Rule 1']);
        expect(first.nextCursor).not.toBeNull();
        const second = await caller.alertRules.list({ limit: 2, cursor: first.nextCursor! });
        expect(second.rules.map((r) => r.name)).toEqual(['Rule 2']);
        expect(second.nextCursor).toBeNull();
        expect((await caller.alertRules.list({ limit: 5, folder: 'b' })).rules.map((r) => r.name)).toEqual(['Rule 2']);
        expect((await caller.alertRules.list({ limit: 5, name: 'rule_' })).rules).toEqual([]);
        expect((await caller.alertRules.list({ limit: 5, label: { key: 'owner', value: 'o1' } })).rules.map((r) => r.name)).toEqual([
          'Rule 1',
        ]);
      }));
  });
}

suite('alert rules over the memory store', async () => ({ store: createMemoryAlertRuleStore(), close: async () => undefined }));

describe('alert rule guards', () => {
  it('refuses with a named code when no storage is configured, and never lists an invented rule', async () => {
    const caller = await api(undefined);
    await expect(caller.alertRules.list({ limit: 10 })).rejects.toMatchObject({
      message: expect.stringContaining('ops.alert_storage_unconfigured'),
    });
    await expect(caller.alertRules.create(draft)).rejects.toMatchObject({
      message: expect.stringContaining('ops.alert_storage_unconfigured'),
    });
  });

  it('refuses a list with no page size, instead of inventing one', async () => {
    const caller = await api(createMemoryAlertRuleStore());
    await expect(caller.alertRules.list({})).rejects.toMatchObject({ message: expect.stringContaining('ops.alert_list_limit_unset') });
  });

  it('needs the operator scope, and a second factor to change a rule', async () => {
    const reader = await api(createMemoryAlertRuleStore(), principal({ scopes: ['admin:read'] }));
    await expect(reader.alertRules.create(draft)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const noMfa = await api(createMemoryAlertRuleStore(), principal({ mfa: false }));
    await expect(noMfa.alertRules.create(draft)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('ops.alert_forbidden'),
    });
    const none = await api(createMemoryAlertRuleStore(), principal({ scopes: ['ops:read'] }));
    await expect(none.alertRules.list({ limit: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('alert rules on real PostgreSQL', () => {
  const open = async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 6, onnotice: () => undefined });
    await migrateOutreach(sql);
    return {
      sql,
      database,
      store: createPgAlertRuleStore(sql),
      close: async () => {
        await sql.end();
        await database.drop();
      },
    };
  };

  suite('alert rules over the PostgreSQL store', open);

  it('keeps a rule and its versions across a restart', async () => {
    const opened = await open();
    try {
      const caller = await api(opened.store);
      const rule = await caller.alertRules.create(draft);
      await opened.sql.end();
      const restarted = postgres(opened.database.url, { max: 2, onnotice: () => undefined });
      try {
        await migrateOutreach(restarted);
        const again = await api(createPgAlertRuleStore(restarted));
        expect(await again.alertRules.get({ id: rule.id })).toEqual(rule);
        expect(await again.alertRules.create(draft)).toEqual(rule);
        expect((await again.alertRules.versions({ id: rule.id, limit: 5 })).versions).toHaveLength(1);
      } finally {
        await restarted.end();
      }
    } finally {
      await opened.database.drop();
    }
  });

  it('saves one rule when the same create races, and one winner when two rules race for a label set', async () => {
    const opened = await open();
    try {
      const caller = await api(opened.store);
      const same = await Promise.all(Array.from({ length: 5 }, () => caller.alertRules.create(draft)));
      expect(new Set(same.map((r) => r.id)).size).toBe(1);
      const rivals = await Promise.allSettled(
        [1, 2].map((n) =>
          caller.alertRules.create({ ...draft, name: `Rival ${n}`, labels: { owner: 'rival' }, idempotencyKey: `alert-rival-${n}0000` }),
        ),
      );
      expect(rivals.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(rivals.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { message: expect.stringContaining('ops.alert_labels_duplicate') },
      });
    } finally {
      await opened.close();
    }
  });

  it('refuses to edit or delete a stored version, and reverses cleanly', async () => {
    const opened = await open();
    try {
      const caller = await api(opened.store);
      await caller.alertRules.create(draft);
      await expect(opened.sql`UPDATE ops.alert_rule_versions SET reason='forged'`).rejects.toThrow(/alert_rule_version_immutable/);
      await expect(opened.sql`DELETE FROM ops.alert_rule_versions`).rejects.toThrow(/alert_rule_version_immutable/);
      await migrateOutreach(opened.sql, 'down');
      await migrateOutreach(opened.sql);
      expect(await opened.store.list({ includeRetired: true, limit: 5 })).toEqual([]);
    } finally {
      await opened.close();
    }
  });
});
