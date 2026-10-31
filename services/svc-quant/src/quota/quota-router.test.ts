import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import type { QuotaStore } from './postgres-store.js';
import { usageOf, zeroCounts, type QuotaResource } from './quota.js';

const SECRET = 'a-quant-quota-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

/** A store that records writes and answers usage for one profile: enough to test the procedures, not the counting. */
function fakeStore() {
  const writes: unknown[] = [];
  const store: QuotaStore = {
    async setLimit(input) {
      writes.push(input);
      return { profile: input.profile, resource: input.resource, limit: input.limit, seq: 1 };
    },
    async assign(input) {
      writes.push(input);
      return { accountId: input.accountId, profile: input.profile, seq: 1 };
    },
    async usage(accountId) {
      const counts = zeroCounts();
      counts.strategies = accountId === ACCOUNT_A ? 2n : 0n;
      return usageOf('TEST', new Map<QuotaResource, bigint | null>([['strategies', 3n]]), counts);
    },
  };
  return { store, writes };
}

function setup() {
  const { store, writes } = fakeStore();
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createMemoryStrategyRepository(),
    quota: store,
  });
  return { a: app.createCaller(signed(ACCOUNT_A)), operator: app.createCaller(signed(OPERATOR, ['admin:write'])), writes };
}

describe('quota procedures (AL-limits-01)', () => {
  it('shows the caller their profile, each limit or not set, and what is used', async () => {
    const { a } = setup();
    const usage = await a.quota.get();
    expect(usage.profile).toBe('TEST');
    expect(usage.rows).toHaveLength(9);
    expect(usage.rows.find((row) => row.resource === 'strategies')).toEqual({ resource: 'strategies', limit: '3', used: '2' });
    expect(usage.rows.find((row) => row.resource === 'stored_runs')).toEqual({ resource: 'stored_runs', limit: null, used: '0' });
  });

  it('lets only an operator set a limit or assign a profile, with the operator recorded as the writer', async () => {
    const { a, operator, writes } = setup();
    const input = {
      profile: 'TEST',
      resource: 'stored_runs' as const,
      limit: '3',
      reason: 'LOCAL TEST',
      idempotencyKey: 'quant.quota:TEST:stored_runs:1',
    };
    await expect(a.ops.quota.set(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(operator.ops.quota.set(input)).resolves.toEqual({ profile: 'TEST', resource: 'stored_runs', limit: '3', seq: 1 });
    await expect(operator.ops.quota.set({ ...input, limit: '3.5' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(operator.ops.quota.set({ ...input, reason: ' ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      operator.ops.quota.assign({ accountId: ACCOUNT_A, profile: 'TEST', reason: 'LOCAL TEST', idempotencyKey: 'assign:a:1' }),
    ).resolves.toMatchObject({
      profile: 'TEST',
    });
    expect(writes).toEqual([
      { ...input, setBy: OPERATOR },
      { accountId: ACCOUNT_A, profile: 'TEST', reason: 'LOCAL TEST', idempotencyKey: 'assign:a:1', assignedBy: OPERATOR },
    ]);
  });

  it('refuses by naming the missing database when no store is wired', async () => {
    const app = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: 8_000 },
      strategies: createMemoryStrategyRepository(),
    });
    await expect(app.createCaller(signed(ACCOUNT_A)).quota.get()).rejects.toThrow(/quant\.database_url_unset/);
  });
});
