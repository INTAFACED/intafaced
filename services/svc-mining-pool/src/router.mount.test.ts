import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createMiningRouter, type MiningReads } from './router.js';

const SECRET = 'mining-mount-test-edge-secret-32chars';
const USER = '11111111-1111-4111-8111-111111111111';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-mining-pool' });

beforeEach(() => {
  vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
  vi.stubEnv('APP_ENV', 'test');
});

afterEach(() => vi.unstubAllEnvs());

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['ledger:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon' });

function signed(p: Principal = principal()) {
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

function forged(p: Principal = principal()) {
  return edgeContext({
    headers: { 'x-intafaced-principal': encodePrincipal(p), 'x-intafaced-region': 'DE' },
    id: 'forged',
  });
}

function reads(): MiningReads & { myWorkers: ReturnType<typeof vi.fn> } {
  return {
    myWorkers: vi.fn(async () => ({ asOf: '2026-01-01T00:00:00.000Z', windowMinutes: 60, workers: [] })),
    listWorkers: vi.fn(async () => ({ asOf: '2026-01-01T00:00:00.000Z', workers: [], nextCursor: null })),
    myShares: vi.fn(),
    opsShares: vi.fn(),
    opsWindows: vi.fn(),
    pending: vi.fn(),
    myPayouts: vi.fn(),
  };
}

describe('mining tRPC mount', () => {
  it('refuses an unsigned caller and a forged principal before the handler', async () => {
    const store = reads();
    const router = createMiningRouter(store);
    await expect(router.createCaller(anonymous()).workers.mine({ windowMinutes: 60 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(forged().principal).toBeNull();
    await expect(router.createCaller(forged()).workers.mine({ windowMinutes: 60 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(store.myWorkers).not.toHaveBeenCalled();
  });

  it('refuses a signed caller who lacks the scope, and reaches the handler when ledger:read is present', async () => {
    const store = reads();
    const router = createMiningRouter(store);
    await expect(
      router.createCaller(signed(principal({ scopes: ['identity:read'] }))).workers.mine({ windowMinutes: 60 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'scope.denied' } });
    expect(store.myWorkers).not.toHaveBeenCalled();
    await expect(router.createCaller(signed()).workers.mine({ windowMinutes: 60 })).resolves.toMatchObject({ workers: [] });
    expect(store.myWorkers).toHaveBeenCalledWith(USER, 60);
  });

  it('refuses operator reads without admin:read', async () => {
    const store = reads();
    const router = createMiningRouter(store);
    await expect(router.createCaller(signed()).ops.workers({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'scope.denied' },
    });
    expect(store.listWorkers).not.toHaveBeenCalled();
    await expect(router.createCaller(signed(principal({ scopes: ['admin:read'] }))).ops.workers({ limit: 10 })).resolves.toMatchObject({
      workers: [],
    });
    expect(store.listWorkers).toHaveBeenCalledWith(10, null);
  });

  it('refuses a blank worker page limit before the handler', async () => {
    const store = reads();
    await expect(
      createMiningRouter(store)
        .createCaller(signed(principal({ scopes: ['admin:read'] })))
        .ops.workers({}),
    ).rejects.toMatchObject({
      cause: { code: 'mining.workers_list_limit_unset' },
    });
    expect(store.listWorkers).not.toHaveBeenCalled();
  });

  it('refuses worker registration with the typed code and does not read or write', async () => {
    const store = reads();
    await expect(createMiningRouter(store).createCaller(signed()).workers.register()).rejects.toMatchObject({
      cause: { code: 'mining.worker_registration_scope_unset' },
    });
    expect(store.myWorkers).not.toHaveBeenCalled();
  });

  it('terms is any signed-in caller, and an unsigned caller is refused', async () => {
    vi.stubEnv('MINING_POOL_FEE_BPS', '100');
    vi.stubEnv('MINING_POOL_WINDOW_SIZE', '30');
    const router = createMiningRouter(reads());
    await expect(router.createCaller(anonymous()).terms()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(router.createCaller(signed(principal({ scopes: ['identity:read'], tier: 'none' }))).terms()).resolves.toEqual({
      feeBps: 100,
      feeReason: null,
      windowSize: 30,
      windowSizeReason: null,
    });
  });

  it('refuses a signed caller when screening is unset, before the handler', async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'yes');
    const store = reads();
    await expect(createMiningRouter(store).createCaller(signed()).workers.mine({ windowMinutes: 60 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'denied.screening_unconfigured' },
    });
    expect(store.myWorkers).not.toHaveBeenCalled();
  });
});
