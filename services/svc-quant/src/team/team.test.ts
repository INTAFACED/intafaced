import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type QuantSignalRules,
} from '@intafaced/contracts';
import type { FeePort, HistoryPort } from '../engine/ports.js';
import { createMemoryQuota } from '../quota/memory.js';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { createMemoryTeamRepository } from './memory-repository.js';

// AL-team-01, AL-limits-01 (J-algo-dev-08): share a strategy with a teammate, the edit lock, the plan's collaborator
// limit, the support grant with its audit rows, and removal.
const SECRET = 'a-quant-team-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const THIRD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUPPORT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

function signed(userId: string, scopes: string[] = ['trade:read']) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return edgeContext({
    headers: { 'x-intafaced-region': 'DE', [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE') },
    id: `req-${userId}-${scopes.join(',')}`,
  });
}

const history: HistoryPort = { wired: true, bars: async () => [] } as HistoryPort;
const fees: FeePort = { wired: true, fee: async () => ({ version: 'local-test:v1', makerBps: 8, takerBps: 10 }) } as FeePort;

function setup(editLockSeconds: number | null = 20) {
  let offset = 0;
  const now = () => Date.now() + offset;
  const quota = createMemoryQuota({ defaultProfile: 'TEST default' });
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createMemoryStrategyRepository(quota.gate),
    runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES, quota.gate),
    team: createMemoryTeamRepository(quota.gate),
    quota: quota.repository,
    editLockSeconds,
    releaseNoteMax: 500,
    history,
    fees,
    now,
  });
  const writer = app.createCaller(signed(OPERATOR, ['admin:write']));
  return {
    owner: app.createCaller(signed(OWNER)),
    mate: app.createCaller(signed(MATE)),
    other: app.createCaller(signed(OTHER)),
    support: app.createCaller(signed(SUPPORT, ['admin:read'])),
    later: (seconds: number) => {
      offset += seconds * 1000;
    },
    async plan(collaborators: string) {
      const limits = {
        strategies: '10',
        versions: '10',
        concurrent_runs: '10',
        paper_runs: '10',
        runs: '10',
        storage: '10000000',
        collaborators,
      };
      for (const [resource, limit] of Object.entries(limits)) {
        await writer.ops.quota.set({
          profile: 'TEST default',
          resource: resource as 'runs',
          limit,
          reason: 'LOCAL TEST',
          idempotencyKey: `q:${resource}:${limit}`,
        });
      }
    },
  };
}

async function saved(t: ReturnType<typeof setup>) {
  return t.owner.studio.save({
    name: 'TEST shared trend',
    blocks: [],
    modules: RULES,
    risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
    cash: '1000',
    environment: 'paper',
    clientStrategyId: 'client-team',
    idempotencyKey: 'save-team',
  });
}

describe('sharing a strategy (AL-team-01)', () => {
  it('view only opens and refuses the save as permission denied; edit saves a new version on the owner', async () => {
    const t = setup();
    await t.plan('5');
    const s = await saved(t);
    await expect(t.mate.team.open({ strategyId: s.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'view', liveControl: false });
    const opened = await t.mate.team.open({ strategyId: s.id });
    expect(opened).toMatchObject({ role: 'view', name: 'TEST shared trend', version: 1, ownerId: OWNER });
    expect(opened.source.length).toBeGreaterThan(0);
    await expect(t.mate.team.save({ strategyId: s.id, baseVersion: 1, name: 'TEST mate' })).rejects.toThrow(/^quant\.permission_denied — /);
    expect((await t.owner.studio.get({ id: s.id })).versions).toHaveLength(1);

    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'edit', liveControl: false });
    const after = await t.mate.team.save({ strategyId: s.id, baseVersion: 1, name: 'TEST mate edit', releaseNote: 'tightened' });
    expect(after).toMatchObject({ version: 2, name: 'TEST mate edit', releaseNote: 'tightened' });
    // The same save again is the same version.
    expect((await t.mate.team.save({ strategyId: s.id, baseVersion: 1, name: 'TEST mate edit', releaseNote: 'tightened' })).version).toBe(
      2,
    );
    expect((await t.owner.studio.get({ id: s.id })).versions).toHaveLength(2);
    // Someone it is not shared with sees nothing.
    await expect(t.other.team.save({ strategyId: s.id, baseVersion: 1, name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(t.other.team.get({ strategyId: s.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses the owner, a non-id and a stop of the owner run without live control', async () => {
    const t = setup();
    await t.plan('5');
    const s = await saved(t);
    await expect(t.owner.team.set({ strategyId: s.id, memberId: OWNER, role: 'edit', liveControl: false })).rejects.toThrow(
      /^quant\.team_member_invalid/,
    );
    await expect(t.owner.team.set({ strategyId: s.id, memberId: 'bob@example.com', role: 'edit', liveControl: false })).rejects.toThrow(
      /^quant\.team_member_invalid/,
    );
    await expect(t.mate.team.set({ strategyId: s.id, memberId: OTHER, role: 'edit', liveControl: false })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'edit', liveControl: false });
    await expect(t.mate.team.stop({ strategyId: s.id, runId: 'any' })).rejects.toThrow(/^quant\.permission_denied — /);
  });
});

describe('the edit lock (AL-team-01)', () => {
  it('holds the owner out until it lapses, then the owner takes it and the teammate is held out', async () => {
    const t = setup(20);
    await t.plan('5');
    const s = await saved(t);
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'edit', liveControl: false });
    const lock = await t.mate.team.lock({ strategyId: s.id });
    expect(lock).toMatchObject({ held: true, mine: true, holderId: MATE });
    await expect(t.owner.team.lock({ strategyId: s.id })).rejects.toThrow(
      new RegExp(`^quant\\.edit_locked — another person holds the edit lock until ${lock.expiresAt}`),
    );
    const update = {
      id: s.id,
      name: 'TEST owner',
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper' as const,
      idempotencyKey: 'owner-update',
    };
    await expect(t.owner.studio.update(update)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await t.owner.team.get({ strategyId: s.id })).lock).toMatchObject({ held: true, mine: false, holderId: MATE });
    t.later(21);
    expect((await t.owner.team.get({ strategyId: s.id })).lock).toEqual({ held: false, holderId: null, mine: false, expiresAt: null });
    expect(await t.owner.team.lock({ strategyId: s.id })).toMatchObject({ held: true, mine: true });
    expect((await t.owner.studio.update(update)).version).toBe(2);
    await expect(t.mate.team.save({ strategyId: s.id, baseVersion: 2, name: 'TEST mate' })).rejects.toThrow(/^quant\.edit_locked/);
  });

  it('refuses taking a lock when its length is blank', async () => {
    const t = setup(null);
    await t.plan('5');
    const s = await saved(t);
    await expect(t.owner.team.lock({ strategyId: s.id })).rejects.toThrow(/^quant\.edit_lock_unset/);
  });
});

describe('the plan limit on collaborators (AL-limits-01)', () => {
  it('adds up to the limit and refuses one more naming the collaborators resource; a permission change adds none', async () => {
    const t = setup();
    await t.plan('2');
    const s = await saved(t);
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'view', liveControl: false });
    await t.owner.team.set({ strategyId: s.id, memberId: OTHER, role: 'view', liveControl: false });
    await expect(t.owner.team.set({ strategyId: s.id, memberId: THIRD, role: 'view', liveControl: false })).rejects.toThrow(
      /^quant\.quota_exceeded — collaborators: 2 used of 2 allowed/,
    );
    expect((await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'edit', liveControl: false })).collaborators).toHaveLength(2);
    const usage = await t.owner.quota.get();
    expect(usage.resources.find((row) => row.resource === 'collaborators')).toEqual({ resource: 'collaborators', used: '2', limit: '2' });
  });
});

describe('the support grant (AL-team-01)', () => {
  it('shows source only while the grant lasts; every read writes an audit row', async () => {
    const t = setup();
    await t.plan('5');
    const s = await saved(t);
    const before = await t.support.ops.strategy.source({ strategyId: s.id, ownerId: OWNER });
    expect(before).toMatchObject({ granted: false, source: null, name: 'TEST shared trend', versions: 1 });
    await expect(t.owner.team.grant({ strategyId: s.id, seconds: 5, seq: 0 })).rejects.toThrow(/^quant\.grant_invalid/);
    const granted = await t.owner.team.grant({ strategyId: s.id, seconds: 60, seq: 0 });
    expect(granted.grants).toHaveLength(1);
    // The same grant again is the same grant.
    expect((await t.owner.team.grant({ strategyId: s.id, seconds: 60, seq: 0 })).grants).toHaveLength(1);
    const during = await t.support.ops.strategy.source({ strategyId: s.id, ownerId: OWNER });
    expect(during.granted).toBe(true);
    expect(during.source).toBe((await t.owner.studio.get({ id: s.id })).source);
    t.later(61);
    const after = await t.support.ops.strategy.source({ strategyId: s.id, ownerId: OWNER });
    expect(after).toMatchObject({ granted: false, source: null });
    const team = await t.owner.team.get({ strategyId: s.id });
    expect(team.reads.map((row) => [row.reader, row.granted])).toEqual([
      [SUPPORT, false],
      [SUPPORT, true],
      [SUPPORT, false],
    ]);
    expect(team.grants[0]!.active).toBe(false);
    // A customer session is not support.
    await expect(t.mate.ops.strategy.source({ strategyId: s.id, ownerId: OWNER })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('removing a teammate (AL-team-01)', () => {
  it('fails their next request and drops their lock; the owner paper run keeps going', async () => {
    const t = setup();
    await t.plan('5');
    const s = await saved(t);
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'edit', liveControl: true });
    await t.mate.team.lock({ strategyId: s.id });
    const run = await t.owner.paper.start({
      strategyId: s.id,
      strategyVersion: 1,
      cash: '1000',
      holdings: [],
      feed: 'own_venue',
      costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
      ordinal: 0,
    });
    expect((await t.mate.team.paperRuns({ strategyId: s.id })).runs.map((row) => row.state)).toEqual(['running']);
    await t.owner.team.remove({ strategyId: s.id, memberId: MATE });
    await expect(t.mate.team.open({ strategyId: s.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(t.mate.team.stop({ strategyId: s.id, runId: run.runId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await t.owner.team.get({ strategyId: s.id })).lock.held).toBe(false);
    expect((await t.owner.paper.get({ runId: run.runId })).state).toBe('running');
  });

  it('with live control the teammate stops the owner paper run', async () => {
    const t = setup();
    await t.plan('5');
    const s = await saved(t);
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'edit', liveControl: true });
    const run = await t.owner.paper.start({
      strategyId: s.id,
      strategyVersion: 1,
      cash: '1000',
      holdings: [],
      feed: 'own_venue',
      costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
      ordinal: 0,
    });
    expect((await t.mate.team.stop({ strategyId: s.id, runId: run.runId })).state).toBe('stopped');
  });
});

describe('a manual order from a teammate (AL-team-01)', () => {
  const start = (t: ReturnType<typeof setup>, strategyId: string) =>
    t.owner.paper.start({
      strategyId,
      strategyVersion: 1,
      cash: '1000',
      holdings: [],
      feed: 'own_venue',
      costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
      ordinal: 0,
    });

  it('without live control refuses as permission denied, and the run trades on untouched', async () => {
    const t = setup();
    await t.plan('5');
    const s = await saved(t);
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'edit', liveControl: false });
    const run = await start(t, s.id);
    const before = await t.owner.paper.get({ runId: run.runId });
    await expect(t.mate.team.order({ strategyId: s.id, runId: run.runId, side: 'buy', size: '0.01' })).rejects.toThrow(
      /^quant\.permission_denied — /,
    );
    await expect(t.mate.team.order({ strategyId: s.id, runId: run.runId, side: 'buy', size: '0.01' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const after = await t.owner.paper.get({ runId: run.runId });
    expect(after.state).toBe('running');
    expect(after.trades).toEqual(before.trades);
    expect(after.position).toEqual(before.position);
  });

  it('with live control refuses by name, since a paper run takes no manual order; another run or a stranger is not found', async () => {
    const t = setup();
    await t.plan('5');
    const s = await saved(t);
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'edit', liveControl: true });
    const run = await start(t, s.id);
    await expect(t.mate.team.order({ strategyId: s.id, runId: run.runId, side: 'sell', size: '0.01' })).rejects.toThrow(
      /^quant\.paper_manual_order_unsupported — /,
    );
    await expect(t.mate.team.order({ strategyId: s.id, runId: 'no-such-run', side: 'sell', size: '0.01' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(t.other.team.order({ strategyId: s.id, runId: run.runId, side: 'sell', size: '0.01' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(t.mate.team.order({ strategyId: s.id, runId: run.runId, side: 'sell', size: '1e3' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect((await t.owner.paper.get({ runId: run.runId })).state).toBe('running');
  });
});
