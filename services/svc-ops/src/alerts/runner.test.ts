import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase } from '@intafaced/db';
import { migrateOutreach } from '../db/migrate.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { AlertEvaluator, AlertOutboxPublisher, type AlertBus } from './runner.js';
import { createMemoryAlertRuleStore, createPgAlertRuleStore } from './rule-store.js';
import { AlertRules, type AlertRuleStore } from './rules.js';
import type { SignalReader, SignalReading } from './signals.js';
import { createMemoryAlertState, createPgAlertState, type AlertOutbox, type AlertStateStore } from './state-store.js';

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

async function signed(p: Principal = principal()) {
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

const BASE = Date.UTC(2026, 9, 20, 6, 0, 0);

/** A clock the test moves by hand; every component reads the same one. */
function makeClock() {
  let at = BASE;
  return {
    now: () => new Date(at).toISOString(),
    advance: (seconds: number) => {
      at += seconds * 1000;
    },
  };
}

/** A signal the test sets: what the check reads right now. */
function makeSignal(initial: SignalReading) {
  let reading = initial;
  const reader: SignalReader = { read: async () => reading };
  return {
    reader,
    set: (next: SignalReading) => {
      reading = next;
    },
  };
}

const draft = {
  name: 'Ledger postings stalled',
  folder: 'ledger',
  group: 'every-minute',
  signal: 'ledger.postings.count',
  condition: { operator: 'lt' as const, threshold: '1' },
  intervalSeconds: 60,
  pendingSeconds: 60,
  labels: { owner: 'founder' },
  annotations: {},
  noData: 'alerting' as const,
  execError: 'alerting' as const,
  reason: 'first rule',
  idempotencyKey: 'alert-key-0001',
};
const who = { id: USER, reason: 'test', key: 'alert-key-0001' };

interface Rig {
  readonly rules: AlertRules;
  readonly ruleStore: AlertRuleStore;
  readonly state: AlertStateStore;
  readonly outbox: AlertOutbox;
  /** A second set of components over the same storage: a restarted service. */
  readonly restart: () => Promise<{ ruleStore: AlertRuleStore; state: AlertStateStore; outbox: AlertOutbox }>;
  readonly close: () => Promise<void>;
  readonly pendingKeys: () => Promise<string[]>;
}

type Open = (clock: { now: () => string }) => Promise<Rig>;

const keysOf = async (outbox: AlertOutbox) => (await outbox.pending(500)).map((r) => r.idempotencyKey);

function suite(name: string, open: Open) {
  describe(name, () => {
    const withRig = async (run: (rig: Rig, clock: ReturnType<typeof makeClock>) => Promise<void>) => {
      const clock = makeClock();
      const rig = await open(clock);
      try {
        await run(rig, clock);
      } finally {
        await rig.close();
      }
    };
    const evaluator = (rig: Rig, clock: ReturnType<typeof makeClock>, signal: SignalReader) =>
      new AlertEvaluator({ rules: rig.ruleStore, state: rig.state, signals: signal, now: clock.now });

    it('queues one rule event per saved version, with the rule and version as its key', () =>
      withRig(async (rig) => {
        const rule = await rig.rules.create(draft, who);
        const v2 = await rig.rules.update(rule.id, 1, { ...draft, name: 'Ledger stalled' }, { ...who, key: 'alert-key-0002' });
        const paused = await rig.rules.setPaused(rule.id, v2.version, true, { ...who, key: 'alert-key-0003' });
        await rig.rules.retire(rule.id, paused.version, { ...who, key: 'alert-key-0004' });
        // A replay of the first request adds nothing.
        await rig.rules.create(draft, who);
        const rows = await rig.outbox.pending(50);
        expect(rows.map((r) => r.idempotencyKey)).toEqual([1, 2, 3, 4].map((v) => `ops:alert_rule:${rule.id}:${v}`));
        expect(rows.map((r) => (r.payload as { change: string }).change)).toEqual(['created', 'updated', 'paused', 'retired']);
        expect(rows.every((r) => r.event === 'coreOpsAlertRuleUpdated')).toBe(true);
      }));

    it('waits out the pending period, announces the open once, and does not re-check before the interval', () =>
      withRig(async (rig, clock) => {
        const rule = await rig.rules.create(draft, who);
        const signal = makeSignal({ status: 'ok', value: '0' });
        const ev = evaluator(rig, clock, signal.reader);
        expect(await ev.tick()).toEqual({ evaluated: 1, opened: 0, resolved: 0 });
        clock.advance(30);
        expect(await ev.tick()).toEqual({ evaluated: 0, opened: 0, resolved: 0 });
        clock.advance(30);
        expect(await ev.tick()).toEqual({ evaluated: 1, opened: 1, resolved: 0 });
        clock.advance(60);
        expect(await ev.tick()).toEqual({ evaluated: 1, opened: 0, resolved: 0 });
        const opened = (await rig.outbox.pending(50)).filter((r) => r.event === 'coreOpsAlertOpened');
        expect(opened).toHaveLength(1);
        expect(opened[0]?.payload).toMatchObject({ ruleId: rule.id, epoch: 1, state: 'firing' });
      }));

    it('does not announce twice when the service restarts while the alert is firing', () =>
      withRig(async (rig, clock) => {
        await rig.rules.create(draft, who);
        const signal = makeSignal({ status: 'ok', value: '0' });
        await evaluator(rig, clock, signal.reader).tick();
        clock.advance(60);
        await evaluator(rig, clock, signal.reader).tick();
        const before = await keysOf(rig.outbox);
        const again = await rig.restart();
        clock.advance(60);
        const restarted = new AlertEvaluator({ rules: again.ruleStore, state: again.state, signals: signal.reader, now: clock.now });
        expect(await restarted.tick()).toMatchObject({ evaluated: 1, opened: 0 });
        expect(await keysOf(again.outbox)).toEqual(before);
      }));

    it('announces once when several replicas tick at the same moment', () =>
      withRig(async (rig, clock) => {
        await rig.rules.create(draft, who);
        const signal = makeSignal({ status: 'ok', value: '0' });
        await evaluator(rig, clock, signal.reader).tick();
        clock.advance(60);
        const reports = await Promise.all(Array.from({ length: 4 }, () => evaluator(rig, clock, signal.reader).tick()));
        expect(reports.reduce((n, r) => n + r.opened, 0)).toBe(1);
        expect((await rig.outbox.pending(50)).filter((r) => r.event === 'coreOpsAlertOpened')).toHaveLength(1);
      }));

    it('resolves, then opens again as a new episode with its own keys', () =>
      withRig(async (rig, clock) => {
        const rule = await rig.rules.create(draft, who);
        const signal = makeSignal({ status: 'ok', value: '0' });
        const ev = evaluator(rig, clock, signal.reader);
        await ev.tick();
        clock.advance(60);
        await ev.tick();
        signal.set({ status: 'ok', value: '5' });
        clock.advance(60);
        expect(await ev.tick()).toMatchObject({ resolved: 1 });
        signal.set({ status: 'ok', value: '0' });
        clock.advance(60);
        await ev.tick();
        clock.advance(60);
        await ev.tick();
        const rows = (await rig.outbox.pending(50)).filter((r) => r.event !== 'coreOpsAlertRuleUpdated');
        expect(rows.map((r) => [r.event, (r.payload as { epoch: number }).epoch])).toEqual([
          ['coreOpsAlertOpened', 1],
          ['coreOpsAlertResolved', 1],
          ['coreOpsAlertOpened', 2],
        ]);
        expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(3);
        const history = await rig.state.history({ ruleId: rule.id, limit: 20 });
        expect(history.rows.map((h) => h.to)).toEqual(['firing', 'pending', 'normal', 'firing', 'pending']);
        expect(history.truncated).toBe(false);
      }));

    it('treats an unreadable check as an alert, and a paused or retired rule as not checked', () =>
      withRig(async (rig, clock) => {
        const rule = await rig.rules.create(draft, who);
        const signal = makeSignal({ status: 'error', code: 'ops.warehouse_unwired' });
        const ev = evaluator(rig, clock, signal.reader);
        await ev.tick();
        clock.advance(60);
        await ev.tick();
        const states = await rig.state.states([rule.id]);
        expect(states.get(rule.id)).toMatchObject({ state: 'firing', health: 'error', lastCode: 'ops.warehouse_unwired', lastValue: null });
        const paused = await rig.rules.setPaused(rule.id, 1, true, { ...who, key: 'alert-key-0002' });
        clock.advance(600);
        expect(await ev.tick()).toEqual({ evaluated: 0, opened: 0, resolved: 0 });
        await rig.rules.retire(rule.id, paused.version, { ...who, key: 'alert-key-0003' });
        expect(await ev.tick()).toEqual({ evaluated: 0, opened: 0, resolved: 0 });
      }));

    it('publishes in order, marks each as sent, and sends nothing twice', () =>
      withRig(async (rig, clock) => {
        await rig.rules.create(draft, who);
        const signal = makeSignal({ status: 'ok', value: '0' });
        const ev = evaluator(rig, clock, signal.reader);
        await ev.tick();
        clock.advance(60);
        await ev.tick();
        const sent: { name: string; key: string }[] = [];
        const bus: AlertBus = {
          publish: async (name, _payload, opts) => {
            sent.push({ name, key: opts.idempotencyKey });
          },
        };
        const publisher = new AlertOutboxPublisher(rig.outbox, bus, clock.now);
        expect(await publisher.runOnce()).toBe(2);
        expect(sent.map((s) => s.name)).toEqual(['coreOpsAlertRuleUpdated', 'coreOpsAlertOpened']);
        expect(await publisher.runOnce()).toBe(0);
        expect(sent).toHaveLength(2);
      }));

    it('stops at a failed publish so a later row cannot overtake it, and sends it on the next run', () =>
      withRig(async (rig, clock) => {
        await rig.rules.create(draft, who);
        const signal = makeSignal({ status: 'ok', value: '0' });
        const ev = evaluator(rig, clock, signal.reader);
        await ev.tick();
        clock.advance(60);
        await ev.tick();
        const sent: string[] = [];
        let down = true;
        const bus: AlertBus = {
          publish: async (name) => {
            if (down) throw new Error('bus unreachable');
            sent.push(name);
          },
        };
        const publisher = new AlertOutboxPublisher(rig.outbox, bus, clock.now);
        expect(await publisher.runOnce()).toBe(0);
        expect(sent).toEqual([]);
        const [first] = await rig.outbox.pending(5);
        expect(first?.attempts).toBe(1);
        down = false;
        expect(await publisher.runOnce()).toBe(2);
        expect(sent).toEqual(['coreOpsAlertRuleUpdated', 'coreOpsAlertOpened']);
      }));

    it('serves rules with their stored state and the history through the router', () =>
      withRig(async (rig, clock) => {
        const rule = await rig.rules.create(draft, who);
        const caller = createOpsRouter(new OpsService(), undefined, { alertRules: rig.rules, alertState: rig.state }).createCaller(
          await signed(),
        );
        const before = await caller.alertRules.states({ limit: 10 });
        expect(before.items).toEqual([{ rule, status: null }]);
        const signal = makeSignal({ status: 'ok', value: '0' });
        const ev = evaluator(rig, clock, signal.reader);
        await ev.tick();
        clock.advance(60);
        await ev.tick();
        const firing = await caller.alertRules.states({ limit: 10, state: 'firing' });
        expect(firing.items).toHaveLength(1);
        expect(firing.items[0]?.status).toMatchObject({ state: 'firing', epoch: 1, health: 'ok', lastValue: '0' });
        expect((await caller.alertRules.states({ limit: 10, state: 'normal' })).items).toEqual([]);
        expect((await caller.alertRules.states({ limit: 10, health: 'error' })).items).toEqual([]);

        const history = await caller.alertRules.history({ limit: 10, ruleId: rule.id });
        expect(history.rows.map((h) => h.to)).toEqual(['firing', 'pending']);
        expect(history.truncated).toBe(false);
        expect(history.cap).toBe(10);
        expect(history.retention).toEqual({ configured: false, code: 'ops.alert_history_retention_unset' });

        const cut = await caller.alertRules.history({ limit: 1 });
        expect(cut.rows).toHaveLength(1);
        expect(cut.truncated).toBe(true);
        await expect(caller.alertRules.history({})).rejects.toMatchObject({
          message: expect.stringContaining('ops.alert_list_limit_unset'),
        });
        await expect(caller.alertRules.states({})).rejects.toMatchObject({
          message: expect.stringContaining('ops.alert_list_limit_unset'),
        });
      }));
  });
}

suite('alert evaluation over the in-memory state', async (clock) => {
  const state = createMemoryAlertState();
  const ruleStore = createMemoryAlertRuleStore(state);
  return {
    rules: new AlertRules(ruleStore, clock.now),
    ruleStore,
    state,
    outbox: state,
    restart: async () => ({ ruleStore, state, outbox: state }),
    close: async () => undefined,
    pendingKeys: () => keysOf(state),
  };
});

describe('alert state guards', () => {
  it('lists no state and no history when no storage is configured, and says why', async () => {
    const rules = new AlertRules(createMemoryAlertRuleStore());
    const caller = createOpsRouter(new OpsService(), undefined, { alertRules: rules }).createCaller(await signed());
    const states = await caller.alertRules.states({ limit: 5 });
    expect(states).toEqual({ items: [], nextCursor: null });
    await expect(caller.alertRules.history({ limit: 5 })).rejects.toMatchObject({
      message: expect.stringContaining('ops.alert_storage_unconfigured'),
    });
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('alert evaluation on real PostgreSQL', () => {
  const openPg = async (clock: { now: () => string }) => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 8, onnotice: () => undefined });
    await migrateOutreach(sql);
    const state = createPgAlertState(sql);
    const ruleStore = createPgAlertRuleStore(sql);
    const extra: (typeof sql)[] = [];
    const rig: Rig & { sql: typeof sql; database: typeof database } = {
      sql,
      database,
      rules: new AlertRules(ruleStore, clock.now),
      ruleStore,
      state,
      outbox: state,
      restart: async () => {
        const second = postgres(database.url, { max: 4, onnotice: () => undefined });
        extra.push(second);
        const again = createPgAlertState(second);
        return { ruleStore: createPgAlertRuleStore(second), state: again, outbox: again };
      },
      close: async () => {
        await Promise.all(extra.map((c) => c.end()));
        await sql.end();
        await database.drop();
      },
      pendingKeys: () => keysOf(state),
    };
    return rig;
  };

  suite('alert evaluation over the PostgreSQL state', openPg);

  it('refuses to edit or delete a state change, and reverses cleanly', async () => {
    const clock = makeClock();
    const rig = await openPg(clock);
    try {
      const rule = await rig.rules.create(draft, who);
      const ev = new AlertEvaluator({
        rules: rig.ruleStore,
        state: rig.state,
        signals: makeSignal({ status: 'ok', value: '0' }).reader,
        now: clock.now,
      });
      await ev.tick();
      await expect(rig.sql`UPDATE ops.alert_state_history SET to_state='normal'`).rejects.toThrow();
      await expect(rig.sql`DELETE FROM ops.alert_state_history`).rejects.toThrow();
      expect((await rig.state.states([rule.id])).get(rule.id)?.state).toBe('pending');
      await migrateOutreach(rig.sql, 'down');
      await migrateOutreach(rig.sql);
      expect(await rig.state.states([rule.id])).toEqual(new Map());
    } finally {
      await rig.close();
    }
  });
});
