/**
 * Saved strategies are per account. On main, studio.list() is one shared book,
 * so user B receives user A's source. These assertions fail there.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type Context,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { saveStudio } from './save.js';
import { STUDIO_SERVICE_ALLOWLIST } from './scope.js';
import { createMemoryStrategyRepository } from './memory-repository.js';
import { createStudioStore } from './store.js';

const SECRET = 'a-quant-account-scope-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const limits = { maxOps: 5_000, maxSource: 8_000 };
const HERE = dirname(fileURLToPath(import.meta.url));

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const risk = { maxDrawdown: '500', maxNotional: '10000', kill: '100' };
const blocks = [{ side: 'buy' as const, symbol: 'BTC-USD', qty: '0.01' }];
const saveBody = {
  name: 'alpha',
  blocks,
  risk,
  cash: '10000',
  environment: 'paper' as const,
  clientStrategyId: 'client-alpha',
  idempotencyKey: 'idem-alpha',
};

function signed(userId: string, overrides: { scopes?: string[]; sub_account?: string } = {}): Context {
  const principal = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: overrides.scopes ?? ['trade:read'],
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...(overrides.sub_account ? { sub_account: overrides.sub_account } : {}),
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

function router(allowlist?: readonly string[]) {
  return createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits,
    strategies: createMemoryStrategyRepository(),
    ...(allowlist ? { studioServiceAllowlist: allowlist } : {}),
  });
}

describe('saved strategies are per account', () => {
  it('user B lists empty and get of A is not found; A sees their own', async () => {
    const app = router();
    const a = app.createCaller(signed(ACCOUNT_A));
    const b = app.createCaller(signed(ACCOUNT_B));
    const saved = await a.studio.save(saveBody);

    const listed = await b.studio.list({ limit: 50 });
    expect(listed.strategies).toEqual([]);

    const missingId = 'studio_00000000-0000-4000-8000-000000000099';
    const foreign = await b.studio.get({ id: saved.id }).then(
      () => null,
      (err: { code?: string; message?: string }) => err,
    );
    const missing = await b.studio.get({ id: missingId }).then(
      () => null,
      (err: { code?: string; message?: string }) => err,
    );
    expect(foreign).toMatchObject({ code: 'NOT_FOUND' });
    expect(foreign?.message).toBe(missing?.message);
    expect(foreign?.message).not.toMatch(/another|owner|exists/i);

    await expect(b.studio.update({ id: saved.id, ...saveBody })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(b.studio.delete({ id: saved.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(b.studio.run({ id: saved.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const own = await a.studio.list({ limit: 50 });
    expect(own.strategies.map((row) => row.id)).toEqual([saved.id]);
    expect((await a.studio.get({ id: saved.id })).source).toBe(saved.source);
  });

  it('refuses clone of another account as not found', async () => {
    const app = router();
    const a = app.createCaller(signed(ACCOUNT_A));
    const b = app.createCaller(signed(ACCOUNT_B));
    const saved = await a.studio.save(saveBody);
    await expect(b.studio.clone({ id: saved.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await b.studio.list({ limit: 50 })).strategies).toEqual([]);
    expect((await a.studio.list({ limit: 50 })).strategies).toHaveLength(1);
  });

  it('refuses operator metadata without an admin scope', async () => {
    const app = router();
    const a = app.createCaller(signed(ACCOUNT_A));
    const saved = await a.studio.save(saveBody);
    await expect(a.studio.operatorList({ limit: 50 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      app.createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon' })).studio.operatorList({ limit: 50 }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    const admin = app.createCaller(signed(ACCOUNT_B, { scopes: ['admin:read'] }));
    const meta = await admin.studio.operatorList({ limit: 50, accountId: ACCOUNT_A });
    expect(meta.quarantineCount).toBe(0);
    expect(meta.strategies).toEqual([expect.objectContaining({ id: saved.id, accountId: ACCOUNT_A, name: 'alpha' })]);
    expect(meta.strategies.every((row) => !('source' in row) && !('blocks' in row))).toBe(true);
    expect(JSON.stringify(meta)).not.toContain(saved.source);

    const writer = app.createCaller(signed(ACCOUNT_B, { scopes: ['admin:write'] }));
    await expect(writer.studio.operatorList({ limit: 50 })).resolves.toMatchObject({ quarantineCount: 0 });
  });

  it('ignores a body accountId and stores under the session account', async () => {
    const app = router();
    const a = app.createCaller(signed(ACCOUNT_A));
    const b = app.createCaller(signed(ACCOUNT_B));
    const saved = await a.studio.save({ ...saveBody, accountId: ACCOUNT_B });
    expect((await b.studio.list({ limit: 50, accountId: ACCOUNT_A })).strategies).toEqual([]);
    expect((await a.studio.get({ id: saved.id, accountId: ACCOUNT_B })).name).toBe('alpha');
    await expect(b.studio.get({ id: saved.id, accountId: ACCOUNT_A })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const sub = app.createCaller(signed(ACCOUNT_A, { sub_account: ACCOUNT_C }));
    const subSaved = await sub.studio.save({ ...saveBody, name: 'sub', accountId: ACCOUNT_A });
    expect((await a.studio.list({ limit: 50 })).strategies.map((row) => row.id)).toEqual([saved.id]);
    expect((await sub.studio.list({ limit: 50 })).strategies.map((row) => row.id)).toEqual([subSaved.id]);
  });

  it('requires an allow-listed service and an explicit account; no unscoped list', async () => {
    expect(STUDIO_SERVICE_ALLOWLIST).toEqual([]);
    const index = readFileSync(join(HERE, '../index.ts'), 'utf8');
    expect(index).not.toContain('studioServiceAllowlist');
    const routerSrc = readFileSync(join(HERE, '../router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/studio\.list\(\)/);
    const metaSchema = routerSrc.slice(routerSrc.indexOf('const strategyMetadata'), routerSrc.indexOf('const accountField'));
    expect(metaSchema).not.toMatch(/\bsource\b/);
    expect(metaSchema).not.toMatch(/\bblocks\b/);

    const closed = router();
    const outsider = closed.createCaller({ principal: null, service: 'svc-trade', region: 'DE', requestId: 's2s' });
    await expect(outsider.studio.list({ limit: 50, accountId: ACCOUNT_A })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(outsider.studio.save({ ...saveBody, accountId: ACCOUNT_A })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const open = router(['svc-agents']);
    const agent = open.createCaller({ principal: null, service: 'svc-agents', region: 'DE', requestId: 's2s' });
    await expect(agent.studio.list({ limit: 50 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const saved = await agent.studio.save({ ...saveBody, accountId: ACCOUNT_A });
    expect((await agent.studio.list({ limit: 50, accountId: ACCOUNT_A })).strategies.map((row) => row.id)).toEqual([saved.id]);
    expect((await agent.studio.list({ limit: 50, accountId: ACCOUNT_B })).strategies).toEqual([]);

    const session = open.createCaller({ ...signed(ACCOUNT_A), service: 'svc-agents' });
    const owned = await session.studio.save({
      ...saveBody,
      name: 'session',
      accountId: ACCOUNT_B,
      clientStrategyId: 'client-session',
      idempotencyKey: 'idem-session',
    });
    const asA = open.createCaller(signed(ACCOUNT_A));
    const asB = open.createCaller(signed(ACCOUNT_B));
    expect((await asA.studio.list({ limit: 50 })).strategies.map((row) => row.name)).toContain('session');
    expect((await asB.studio.list({ limit: 50 })).strategies).toEqual([]);
    expect(owned.name).toBe('session');

    await expect(
      closed.createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon' })).studio.list({ limit: 50 }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('quarantines an owner-unknown row and does not hand it to a user', () => {
    const fresh = createStudioStore();
    expect(fresh.quarantineCount()).toBe(0);
    expect(fresh.listMetadata()).toEqual([]);

    const store = createStudioStore();
    const owned = saveStudio(saveBody, store, ACCOUNT_A);
    store.save('', { ...owned, id: 'studio_owner_unknown' });
    expect(store.quarantineCount()).toBe(1);
    expect(store.list(ACCOUNT_A).map((row) => row.id)).toEqual([owned.id]);
    expect(store.get(ACCOUNT_A, 'studio_owner_unknown')).toBeUndefined();
    expect(store.get(ACCOUNT_B, owned.id)).toBeUndefined();
    expect(store.list(ACCOUNT_B)).toEqual([]);
    const hidden = store.listMetadata().find((row) => row.id === 'studio_owner_unknown');
    expect(hidden).toMatchObject({ accountId: null, name: 'alpha' });
    expect(hidden && 'source' in hidden).toBe(false);
    expect(hidden && 'blocks' in hidden).toBe(false);
  });
});
