import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { createMemoryQuota } from './memory.js';
import { judgeNeeds, parseLimit, parseQuotaSeed } from './quota.js';

// AL-limits-01: quotas by plan. The router with memory stores; the race at the limit is proven on Postgres (quota.pg.test.ts).
const SECRET = 'a-quant-quota-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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
    headers: {
      'x-intafaced-region': 'DE',
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    },
    id: `req-${userId}-${scopes.join(',')}`,
  });
}

function setup(defaultProfile: string | null = 'TEST default') {
  const quota = createMemoryQuota({ defaultProfile });
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createMemoryStrategyRepository(quota.gate),
    runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES, quota.gate),
    quota: quota.repository,
  });
  const writer = app.createCaller(signed(OPERATOR, ['admin:write']));
  let seq = 0;
  async function limit(profile: string, resource: Parameters<typeof writer.ops.quota.set>[0]['resource'], value: string | null) {
    seq += 1;
    return writer.ops.quota.set({
      profile,
      resource,
      limit: value,
      reason: 'LOCAL TEST limit',
      idempotencyKey: `quant.quota:${profile}:${resource}:${seq}`,
    });
  }
  return {
    a: app.createCaller(signed(ACCOUNT_A)),
    b: app.createCaller(signed(ACCOUNT_B)),
    writer,
    reader: app.createCaller(signed(OPERATOR, ['admin:read'])),
    limit,
  };
}

const strategy = (n: number) => ({
  name: `TEST strategy ${n}`,
  blocks: [{ side: 'buy' as const, symbol: 'BTC-USD', qty: '0.01' }],
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  cash: '10000',
  environment: 'paper',
  clientStrategyId: `client-${n}`,
  idempotencyKey: `save-${n}`,
});

describe('quotas by plan (AL-limits-01)', () => {
  it('refuses a fourth strategy when the plan allows three, naming the resource with its used and allowed counts', async () => {
    const { a, b, limit } = setup();
    await limit('TEST default', 'strategies', '3');
    await limit('TEST default', 'versions', '10');
    await limit('TEST default', 'storage', '1000000');
    for (const n of [1, 2, 3]) await a.studio.save(strategy(n));
    await expect(a.studio.save(strategy(4))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'quant.quota_exceeded — strategies: 3 used of 3 allowed',
    });
    // The same key replays the stored save; it is not a fourth.
    expect((await a.studio.save(strategy(3))).name).toBe('TEST strategy 3');
    // Counts are per account.
    expect((await b.studio.save(strategy(1))).name).toBe('TEST strategy 1');
    expect((await a.studio.list({ limit: 10 })).strategies).toHaveLength(3);
  });

  it('refuses every create at a limit of zero, and a blank limit with quota_unset; the usage view reads "not set" as null', async () => {
    const { a, limit } = setup();
    await limit('TEST default', 'strategies', '0');
    await expect(a.studio.save(strategy(1))).rejects.toThrow('quant.quota_exceeded — strategies: 0 used of 0 allowed');
    await limit('TEST default', 'strategies', null);
    await expect(a.studio.save(strategy(1))).rejects.toThrow('quant.quota_unset — strategies: the limit for saved strategies is not set');
    const usage = await a.quota.get();
    expect(usage.profile).toBe('TEST default');
    expect(usage.source).toBe('default');
    expect(usage.resources.find((row) => row.resource === 'strategies')).toEqual({ resource: 'strategies', used: '0', limit: null });
    expect(usage.resources.map((row) => row.resource)).toEqual([
      'strategies',
      'versions',
      'concurrent_runs',
      'paper_runs',
      'runs',
      'log_lines',
      'storage',
      'collaborators',
      'notifications',
    ]);
  });

  it('refuses with quota_profile_unset while the default profile is blank, and the usage view says no plan applies', async () => {
    const { a } = setup(null);
    await expect(a.studio.save(strategy(1))).rejects.toThrow(/^quant\.quota_profile_unset/);
    const usage = await a.quota.get();
    expect(usage.profile).toBeNull();
    expect(usage.resources.every((row) => row.limit === null)).toBe(true);
  });

  it('applies an assigned profile over the default', async () => {
    const { a, b, writer, limit } = setup();
    await limit('TEST default', 'strategies', '5');
    await limit('TEST default', 'versions', '5');
    await limit('TEST default', 'storage', '1000000');
    await limit('TEST one', 'strategies', '1');
    await limit('TEST one', 'versions', '5');
    await limit('TEST one', 'storage', '1000000');
    await writer.ops.quota.assign({ accountId: ACCOUNT_A, profile: 'TEST one', reason: 'LOCAL TEST', idempotencyKey: 'assign-a' });
    await a.studio.save(strategy(1));
    await expect(a.studio.save(strategy(2))).rejects.toThrow('quant.quota_exceeded — strategies: 1 used of 1 allowed');
    await b.studio.save(strategy(1));
    await b.studio.save(strategy(2));
    expect((await a.quota.get()).source).toBe('assigned');
    expect((await b.quota.get()).source).toBe('default');
  });

  it('counts versions per strategy and a restore from the recycle bin as one more saved strategy', async () => {
    const { a, limit } = setup();
    await limit('TEST default', 'strategies', '1');
    await limit('TEST default', 'versions', '2');
    await limit('TEST default', 'storage', '1000000');
    const saved = await a.studio.save(strategy(1));
    const update = { ...strategy(1), id: saved.id, idempotencyKey: 'update-1' };
    delete (update as { clientStrategyId?: string }).clientStrategyId;
    await a.studio.update(update);
    await expect(a.studio.update({ ...update, idempotencyKey: 'update-2' })).rejects.toThrow(
      'quant.quota_exceeded — versions: 2 used of 2 allowed',
    );
    await a.studio.delete({ id: saved.id, idempotencyKey: 'delete-1' });
    await a.studio.save(strategy(2));
    await expect(a.studio.restore({ id: saved.id, idempotencyKey: 'restore-1' })).rejects.toThrow(
      'quant.quota_exceeded — strategies: 1 used of 1 allowed',
    );
  });

  it('refuses a fourth stored run when the plan allows three; a replayed run is not counted and nothing is stored', async () => {
    const { a, limit } = setup();
    for (const [resource, value] of [
      ['strategies', '5'],
      ['versions', '5'],
      ['concurrent_runs', '5'],
      ['runs', '3'],
      ['storage', '10000000'],
    ] as const)
      await limit('TEST default', resource, value);
    const saved = await a.studio.save(strategy(1));
    for (const n of [1, 2, 3]) await a.studio.run({ id: saved.id, environment: 'paper', idempotencyKey: `run-${n}` });
    await expect(a.studio.run({ id: saved.id, environment: 'paper', idempotencyKey: 'run-4' })).rejects.toThrow(
      'quant.quota_exceeded — runs: 3 used of 3 allowed',
    );
    // The same key again reads the stored run, never a refusal.
    await expect(a.studio.run({ id: saved.id, environment: 'paper', idempotencyKey: 'run-2' })).resolves.toMatchObject({ ok: true });
    // Usage counted from stored rows is proven on Postgres (quota.pg.test.ts); memory reads only the limit here.
    expect((await a.quota.get()).resources.find((row) => row.resource === 'runs')?.limit).toBe('3');
  });

  it('refuses an operator write without a reason, with no change, and only an operator may write', async () => {
    const { a, writer, reader } = setup();
    await expect(
      writer.ops.quota.set({ profile: 'TEST default', resource: 'runs', limit: '3', reason: '  ', idempotencyKey: 'k1' }),
    ).rejects.toThrow(/^quant\.quota_reason_unset/);
    expect((await reader.ops.quota.profile({ profile: 'TEST default' })).limits.find((row) => row.resource === 'runs')?.limit).toBeNull();
    await expect(
      a.ops.quota.set({ profile: 'TEST default', resource: 'runs', limit: '3', reason: 'mine', idempotencyKey: 'k2' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      a.ops.quota.assign({ accountId: ACCOUNT_A, profile: 'TEST big', reason: 'mine', idempotencyKey: 'k3' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A key replays its write; the same key for another write refuses.
    const first = await writer.ops.quota.set({
      profile: 'TEST default',
      resource: 'runs',
      limit: '3',
      reason: 'LOCAL TEST',
      idempotencyKey: 'k4',
    });
    expect(
      await writer.ops.quota.set({ profile: 'TEST default', resource: 'runs', limit: '3', reason: 'LOCAL TEST', idempotencyKey: 'k4' }),
    ).toEqual(first);
    await expect(
      writer.ops.quota.set({ profile: 'TEST default', resource: 'runs', limit: '4', reason: 'LOCAL TEST', idempotencyKey: 'k4' }),
    ).rejects.toThrow(/quant\.idempotency_conflict/);
  });

  it('judges needs in resource order and reads limits as whole numbers', () => {
    expect(() =>
      judgeNeeds({ name: 'p', source: 'default' }, (r) => (r === 'runs' ? 3n : null), [
        { resource: 'runs', used: 3n, adding: 1n },
        { resource: 'concurrent_runs', used: 0n, adding: 1n },
      ]),
    ).toThrow(/^quant\.quota_unset — concurrent_runs/);
    expect(parseLimit('')).toBeNull();
    expect(parseLimit(' 0 ')).toBe(0n);
    expect(() => parseLimit('1.5')).toThrow(/quant\.params_invalid/);
    expect(() => parseLimit('-1')).toThrow(/quant\.params_invalid/);
  });

  it('seeds only a profile whose name says TEST', () => {
    expect(parseQuotaSeed(undefined)).toBeNull();
    expect(parseQuotaSeed('{"profile":"TEST developer","limits":{"runs":"10"}}')).toEqual({
      profile: 'TEST developer',
      limits: { runs: '10' },
    });
    expect(() => parseQuotaSeed('{"profile":"Pro","limits":{"runs":"10"}}')).toThrow(/TEST/);
    expect(() => parseQuotaSeed('{"profile":"TEST x","limits":{"seats":"10"}}')).toThrow(/unknown resource/);
    expect(() => parseQuotaSeed('{"profile":"TEST x","limits":{"runs":"ten"}}')).toThrow(/whole number/);
  });
});
