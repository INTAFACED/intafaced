import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createMiningRouter, type MiningReads } from './router.js';
import {
  alertShareBpsOf,
  alertTrailingMinutesOf,
  canonicalDecimal,
  connectivityOf,
  evaluateSecondsOf,
  quietSecondsOf,
  shareOfWeight,
  stateChangeKey,
  stateOf,
  transitionOf,
  type WorkerOne,
} from './worker-state.js';
import { MINING_WORKER_EVALUATE_JOB, startWorkerEvaluator } from './worker-evaluator.js';
import { MiningError } from './errors.js';

const SECRET = 'mining-worker-state-edge-secret-32chars';
const USER = '11111111-1111-4111-8111-111111111111';
const WORKER = `worker:${USER}:Rig-Q`;
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-mining-pool' });

beforeEach(() => {
  vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
  vi.stubEnv('APP_ENV', 'test');
});
afterEach(() => vi.unstubAllEnvs());

function signed(scopes: string[] = ['ledger:read']) {
  const p: Principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'signed',
  });
}

const ONE: WorkerOne = {
  asOf: '2026-10-31T00:01:00.000Z',
  id: WORKER,
  name: 'Rig-Q',
  windowMinutes: 60,
  hashing: 'hashing',
  hashrate: '3',
  hashrateReason: null,
  connectivity: 'online',
  lastShareAt: '2026-10-31T00:00:30.000Z',
  state: 'active',
  quietSeconds: 60,
  alertLimitMode: null,
  alertLimit: null,
  alertLimitReason: 'mining.alert_limit_unset',
  maintenanceSince: null,
};

function reads() {
  return {
    myWorkers: vi.fn(async () => ({
      asOf: '2026-10-31T00:00:00.000Z',
      windowMinutes: 60,
      nextCursor: null,
      workers: [
        {
          id: WORKER,
          name: 'Rig-Q',
          createdAt: '2026-10-31T00:00:00.000Z',
          hashrate: '1',
          hashrateReason: null,
          minDifficulty: null,
          mode: 'pooled' as const,
        },
      ],
    })),
    setWorkerDifficulty: vi.fn(),
    setWorkerMode: vi.fn(),
    listWorkers: vi.fn(),
    myShares: vi.fn(),
    opsShares: vi.fn(),
    opsWindows: vi.fn(),
    pending: vi.fn(),
    myPayouts: vi.fn(),
    minerSecretStatus: vi.fn(),
    issueMinerSecret: vi.fn(),
    workerOne: vi.fn(async () => ONE),
    workerStateChanges: vi.fn(async () => ({ asOf: ONE.asOf, evaluatedAt: null, rows: [] })),
    setWorkerMaintenance: vi.fn(async () => ({ asOf: ONE.asOf, rows: [{ workerId: WORKER, since: ONE.asOf }] })),
    workerMaintenance: vi.fn(async () => ({ asOf: ONE.asOf, rows: [] })),
    setWorkerAlertLimit: vi.fn(async () => ({ workerId: WORKER, mode: null, manualLimit: null })),
    workerRosterStates: vi.fn(async () => new Map([[WORKER, { state: 'maintenance' as const, lastShareAt: null }]])),
  } satisfies MiningReads;
}

const QUIET = { MINING_WORKER_QUIET_SECONDS: '60' };

describe('worker state rules', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 0, 0, s));

  it('is online only while the newest share is younger than the quiet interval', () => {
    expect(connectivityOf(at(0), at(59), 60)).toBe('online');
    expect(connectivityOf(at(0), at(60), 60)).toBe('offline');
    expect(connectivityOf(null, at(0), 60)).toBe('offline');
  });

  it('records a change only when the state moves, never in maintenance, never for a worker with no share', () => {
    const base = { now: at(90), quietSeconds: 60 };
    expect(transitionOf({ ...base, lastShareAt: at(0), maintenance: false, latest: null })).toEqual({ from: 'online', to: 'offline' });
    expect(transitionOf({ ...base, lastShareAt: at(0), maintenance: false, latest: 'offline' })).toBeNull();
    expect(transitionOf({ ...base, lastShareAt: at(0), maintenance: true, latest: null })).toBeNull();
    expect(transitionOf({ ...base, lastShareAt: null, maintenance: false, latest: null })).toBeNull();
    expect(transitionOf({ ...base, lastShareAt: at(80), maintenance: false, latest: 'offline' })).toEqual({
      from: 'offline',
      to: 'online',
    });
    expect(transitionOf({ ...base, lastShareAt: at(80), maintenance: false, latest: null })).toBeNull();
  });

  it('keys a change by the worker, its newest share and the change it follows, never a random id', () => {
    expect(stateChangeKey('offline', WORKER, at(0), null)).toBe(`mining:worker-offline:${WORKER}:2026-10-31T00:00:00.000Z:first`);
    expect(stateChangeKey('offline', WORKER, at(0), '7')).toBe(`mining:worker-offline:${WORKER}:2026-10-31T00:00:00.000Z:7`);
  });

  it('names a state: maintenance first, else by connectivity, else unknown', () => {
    expect(stateOf(true, null)).toBe('maintenance');
    expect(stateOf(true, 'online')).toBe('maintenance');
    expect(stateOf(false, 'online')).toBe('active');
    expect(stateOf(false, 'offline')).toBe('offline');
    expect(stateOf(false, null)).toBeNull();
  });

  it('reads owner timing exactly: blank and out of range refuse by code, nothing is filled in', () => {
    expect(quietSecondsOf({})).toBe('mining.quiet_interval_unset');
    expect(quietSecondsOf({ MINING_WORKER_QUIET_SECONDS: ' ' })).toBe('mining.quiet_interval_unset');
    expect(quietSecondsOf({ MINING_WORKER_QUIET_SECONDS: '5' })).toBe('mining.quiet_interval_invalid');
    expect(quietSecondsOf(QUIET)).toBe(60);
    expect(evaluateSecondsOf({})).toBe('mining.worker_evaluate_unset');
    expect(evaluateSecondsOf({ MINING_WORKER_EVALUATE_SECONDS: '0' })).toBe('mining.worker_evaluate_invalid');
    expect(evaluateSecondsOf({ MINING_WORKER_EVALUATE_SECONDS: '10' })).toBe(10);
    expect(alertShareBpsOf({})).toBeNull();
    expect(alertShareBpsOf({ MINING_WORKER_ALERT_SHARE_BPS: '10001' })).toBeNull();
    expect(alertShareBpsOf({ MINING_WORKER_ALERT_SHARE_BPS: '2500' })).toBe(2500);
    expect(alertTrailingMinutesOf({})).toBeNull();
    expect(alertTrailingMinutesOf({ MINING_WORKER_ALERT_TRAILING_MINUTES: ' ' })).toBeNull();
    expect(alertTrailingMinutesOf({ MINING_WORKER_ALERT_TRAILING_MINUTES: '0' })).toBeNull();
    expect(alertTrailingMinutesOf({ MINING_WORKER_ALERT_TRAILING_MINUTES: '10081' })).toBeNull();
    expect(alertTrailingMinutesOf({ MINING_WORKER_ALERT_TRAILING_MINUTES: '1440' })).toBe(1440);
  });

  it('works out an automatic limit in exact decimals', () => {
    expect(shareOfWeight(3n, 2500)).toBe('0.75');
    expect(shareOfWeight(40n, 2500)).toBe('10');
    expect(shareOfWeight(1n, 1)).toBe('0.0001');
    expect(shareOfWeight(123456789012345678901234567890n, 10_000)).toBe('123456789012345678901234567890');
    expect(canonicalDecimal('12.500000000000000000')).toBe('12.5');
    expect(canonicalDecimal('007')).toBe('7');
    expect(() => canonicalDecimal('1e3')).toThrow(MiningError);
  });
});

describe('worker evaluator switch', () => {
  it('stays off by code without Postgres, an evaluation interval or a quiet interval', () => {
    const sql = {} as never;
    expect(startWorkerEvaluator({ sql: null, env: { ...QUIET, MINING_WORKER_EVALUATE_SECONDS: '10' } })).toEqual({
      off: 'mining.pg_unavailable',
    });
    expect(startWorkerEvaluator({ sql, env: QUIET })).toEqual({ off: 'mining.worker_evaluate_unset' });
    expect(startWorkerEvaluator({ sql, env: { MINING_WORKER_EVALUATE_SECONDS: '10' } })).toEqual({ off: 'mining.quiet_interval_unset' });
  });

  it('runs on its own interval when both are published', () => {
    const setIntervalFn = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
    const started = startWorkerEvaluator({
      sql: {} as never,
      env: { ...QUIET, MINING_WORKER_EVALUATE_SECONDS: '10' },
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
    });
    expect('host' in started && started.host.list()).toEqual([MINING_WORKER_EVALUATE_JOB]);
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 10_000);
  });
});

describe('worker procedures', () => {
  it('workers.one needs ledger:read and a published quiet interval, and asks only for the caller own worker', async () => {
    const store = reads();
    await expect(
      createMiningRouter(store, undefined, { env: QUIET })
        .createCaller(signed(['identity:read']))
        .workers.one({ workerId: WORKER, windowMinutes: 60 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      createMiningRouter(store, undefined, { env: {} }).createCaller(signed()).workers.one({ workerId: WORKER, windowMinutes: 60 }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'mining.quiet_interval_unset' } });
    await expect(
      createMiningRouter(store, undefined, { env: QUIET }).createCaller(signed()).workers.one({ workerId: WORKER }),
    ).rejects.toMatchObject({ cause: { code: 'mining.hashrate_window_unset' } });
    expect(store.workerOne).not.toHaveBeenCalled();
    const router = createMiningRouter(store, undefined, { env: { ...QUIET, MINING_WORKER_ALERT_SHARE_BPS: '2500' } });
    await expect(router.createCaller(signed()).workers.one({ workerId: WORKER, windowMinutes: 60 })).resolves.toEqual(ONE);
    expect(store.workerOne).toHaveBeenCalledWith(USER, WORKER, 60, { quietSeconds: 60, alertShareBps: 2500, alertTrailingMinutes: null });
    const trailing = createMiningRouter(store, undefined, {
      env: { ...QUIET, MINING_WORKER_ALERT_SHARE_BPS: '2500', MINING_WORKER_ALERT_TRAILING_MINUTES: '1440' },
    });
    await trailing.createCaller(signed()).workers.one({ workerId: WORKER, windowMinutes: 5 });
    expect(store.workerOne).toHaveBeenLastCalledWith(USER, WORKER, 5, {
      quietSeconds: 60,
      alertShareBps: 2500,
      alertTrailingMinutes: 1440,
    });
    await expect(router.createCaller(signed()).workers.one({ workerId: '', windowMinutes: 60 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('a foreign worker is not found', async () => {
    const store = reads();
    store.workerOne.mockRejectedValueOnce(new MiningError('Worker not found', 'mining.worker_not_found'));
    await expect(
      createMiningRouter(store, undefined, { env: QUIET })
        .createCaller(signed())
        .workers.one({ workerId: 'worker:x:y', windowMinutes: 60 }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'mining.worker_not_found' } });
  });

  it("workers.stateChanges reads the caller's own worker, with or without a quiet interval", async () => {
    const store = reads();
    await createMiningRouter(store, undefined, { env: {} }).createCaller(signed()).workers.stateChanges({ workerId: WORKER });
    expect(store.workerStateChanges).toHaveBeenLastCalledWith(USER, WORKER);
  });

  it('maintenance and the alert limit are trade:write; batches are 1 to 50', async () => {
    const store = reads();
    const router = createMiningRouter(store, undefined, { env: QUIET });
    await expect(router.createCaller(signed()).workers.setMaintenance({ workerIds: [WORKER], on: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(router.createCaller(signed()).workers.setAlertLimit({ workerId: WORKER, mode: null })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const writer = router.createCaller(signed(['trade:write']));
    await expect(writer.workers.setMaintenance({ workerIds: [], on: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      writer.workers.setMaintenance({ workerIds: Array.from({ length: 51 }, (_, i) => `w${i}`), on: true }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(store.setWorkerMaintenance).not.toHaveBeenCalled();
    await expect(writer.workers.setMaintenance({ workerIds: [WORKER], on: true })).resolves.toMatchObject({ rows: [{ workerId: WORKER }] });
    expect(store.setWorkerMaintenance).toHaveBeenCalledWith(USER, [WORKER], true);
    await expect(writer.workers.setAlertLimit({ workerId: WORKER, mode: 'manual', limit: '1e3' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await writer.workers.setAlertLimit({ workerId: WORKER, mode: 'manual', limit: '12.5' });
    expect(store.setWorkerAlertLimit).toHaveBeenLastCalledWith(USER, WORKER, 'manual', '12.5');
    store.setWorkerAlertLimit.mockRejectedValueOnce(new MiningError('bad', 'mining.alert_limit_invalid'));
    await expect(writer.workers.setAlertLimit({ workerId: WORKER, mode: 'automatic', limit: '1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'mining.alert_limit_invalid' },
    });
  });

  it('workers.maintenance is the caller own list under ledger:read', async () => {
    const store = reads();
    await createMiningRouter(store).createCaller(signed()).workers.maintenance();
    expect(store.workerMaintenance).toHaveBeenCalledWith(USER);
  });

  it('the roster carries each worker state, and says why when there is none', async () => {
    const store = reads();
    const withQuiet = await createMiningRouter(store, undefined, { env: QUIET }).createCaller(signed()).workers.mine({ windowMinutes: 60 });
    expect(withQuiet.workers[0]).toMatchObject({ state: 'maintenance', stateReason: null });
    expect(store.workerRosterStates).toHaveBeenLastCalledWith(USER, [WORKER], 60);
    store.workerRosterStates.mockResolvedValueOnce(new Map([[WORKER, { state: null, lastShareAt: null }]]) as never);
    const blank = await createMiningRouter(store, undefined, { env: {} }).createCaller(signed()).workers.mine({ windowMinutes: 60 });
    expect(blank.workers[0]).toMatchObject({ state: null, stateReason: 'mining.quiet_interval_unset' });
    store.workerRosterStates.mockResolvedValueOnce(new Map() as never);
    const unseen = await createMiningRouter(store, undefined, { env: QUIET }).createCaller(signed()).workers.mine({ windowMinutes: 60 });
    expect(unseen.workers[0]).toMatchObject({ state: null, stateReason: null });
    store.workerRosterStates.mockResolvedValueOnce(new Map([[WORKER, { state: null, lastShareAt: null }]]) as never);
    const invalid = await createMiningRouter(store, undefined, { env: { MINING_WORKER_QUIET_SECONDS: '5' } })
      .createCaller(signed())
      .workers.mine({ windowMinutes: 60 });
    expect(invalid.workers[0]).toMatchObject({ state: null, stateReason: 'mining.quiet_interval_invalid' });
  });
});
