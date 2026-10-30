import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { createMemoryStrategyRepository } from './memory-repository.js';

const SECRET = 'a-quant-persist-router-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const limits = { maxOps: 5_000, maxSource: 8_000 };
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const body = {
  name: 'alpha',
  blocks: [{ side: 'buy' as const, symbol: 'BTC-USD', qty: '0.01' }],
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  cash: '10000',
  environment: 'paper' as const,
};

function signed(userId: string, scopes: string[] = ['trade:read']) {
  const principal = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } satisfies Parameters<typeof encodePrincipal>[0];
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-region': 'DE',
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    },
    id: `req-${userId}`,
  });
}

describe('strategy heads and the recycle bin (AL-editor-01)', () => {
  function setup() {
    const strategies = createMemoryStrategyRepository();
    const app = createQuantRouter({ wired: true, venueVaultSet: false, limits, strategies });
    return { a: app.createCaller(signed(ACCOUNT_A)), b: app.createCaller(signed(ACCOUNT_B)) };
  }

  it('renames, moves and describes the head without adding a version, and replays under the same key', async () => {
    const { a } = setup();
    const saved = await a.studio.save({ ...body, clientStrategyId: 'client-alpha', idempotencyKey: 'studio.save:client-alpha' });
    expect(saved).toMatchObject({ folder: '', description: '', organised: 0, restores: 0 });
    const key = `studio.organise:${saved.id}:0`;
    const moved = await a.studio.organise({
      id: saved.id,
      name: ' Trend ',
      folder: 'Momentum',
      description: 'Two averages',
      idempotencyKey: key,
    });
    expect(moved).toMatchObject({ name: 'Trend', folder: 'Momentum', description: 'Two averages', organised: 1, version: 1 });
    expect(moved.versions).toHaveLength(1);
    expect(moved.versions[0]?.name).toBe('alpha');
    // A lost reply sent again under the same key returns the same head and changes nothing more.
    const replayed = await a.studio.organise({ id: saved.id, name: 'Other', folder: '', description: '', idempotencyKey: key });
    expect(replayed).toMatchObject({ name: 'Trend', folder: 'Momentum', organised: 1 });
    const listed = await a.studio.list({ limit: 10 });
    expect(listed.strategies).toEqual([expect.objectContaining({ id: saved.id, name: 'Trend', folder: 'Momentum', version: 1 })]);
    // A saved version names the strategy again.
    const revised = await a.studio.update({ ...body, id: saved.id, name: 'Trend v2', idempotencyKey: `studio.update:${saved.id}:v2` });
    expect(revised).toMatchObject({ name: 'Trend v2', folder: 'Momentum', version: 2 });
  });

  it('refuses a blank name, a nested folder and a foreign id by name', async () => {
    const { a, b } = setup();
    const saved = await a.studio.save({ ...body, clientStrategyId: 'client-alpha', idempotencyKey: 'studio.save:client-alpha' });
    await expect(a.studio.organise({ id: saved.id, name: ' ', folder: '', description: '', idempotencyKey: 'k1' })).rejects.toThrow(
      /name — the strategy name is unset/,
    );
    await expect(a.studio.organise({ id: saved.id, name: 'x', folder: 'a/b', description: '', idempotencyKey: 'k2' })).rejects.toThrow(
      /folder — one level only/,
    );
    await expect(b.studio.organise({ id: saved.id, name: 'x', folder: '', description: '', idempotencyKey: 'k3' })).rejects.toThrow(
      /strategy not found/,
    );
    await expect(b.studio.restore({ id: saved.id, idempotencyKey: 'k4' })).rejects.toThrow(/strategy not found/);
    await expect(a.studio.organise({ id: saved.id, name: 'x', folder: '', description: '' })).rejects.toThrow(/idempotencyKey is unset/);
  });

  it('moves a deleted strategy to the recycle bin with its versions and restores it with the same versions', async () => {
    const { a, b } = setup();
    const saved = await a.studio.save({ ...body, clientStrategyId: 'client-alpha', idempotencyKey: 'studio.save:client-alpha' });
    await a.studio.update({ ...body, id: saved.id, name: 'alpha', idempotencyKey: `studio.update:${saved.id}:v2` });
    await a.studio.delete({ id: saved.id, idempotencyKey: `studio.delete:${saved.id}:0` });
    expect((await a.studio.list({ limit: 10 })).strategies).toEqual([]);
    const bin = await a.studio.listDeleted({ limit: 10 });
    expect(bin.strategies).toEqual([expect.objectContaining({ id: saved.id, version: 2 })]);
    expect(bin.strategies[0]?.deletedAt).not.toBeNull();
    expect((await b.studio.listDeleted({ limit: 10 })).strategies).toEqual([]);

    const key = `studio.restore:${saved.id}:${bin.strategies[0]?.deletedAt}`;
    const restored = await a.studio.restore({ id: saved.id, idempotencyKey: key });
    expect(restored).toMatchObject({ id: saved.id, deletedAt: null, restores: 1, version: 2 });
    expect(restored.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(await a.studio.restore({ id: saved.id, idempotencyKey: key })).toMatchObject({ restores: 1 });
    expect((await a.studio.listDeleted({ limit: 10 })).strategies).toEqual([]);
    expect((await a.studio.list({ limit: 10 })).strategies.map((s) => s.id)).toEqual([saved.id]);

    // A delete after the restore is keyed by the restore count, so it is a new delete, not a replay of the first.
    await a.studio.delete({ id: saved.id, idempotencyKey: `studio.delete:${saved.id}:1` });
    expect((await a.studio.listDeleted({ limit: 10 })).strategies.map((s) => s.id)).toEqual([saved.id]);
  });

  it('refuses a blank recycle bin page size by name', async () => {
    const { a } = setup();
    await expect(a.studio.listDeleted({})).rejects.toThrow(/quant.studio_list_limit_unset|limit/);
  });
});
