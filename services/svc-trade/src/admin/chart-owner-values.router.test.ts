/**
 * C-ops-04 router: the door refuses by schema before the service is reached. No database here.
 * A support reader (admin:read) reads and cannot write; an unset or out-of-bound value never reaches the store.
 */
import { describe, expect, it, vi } from 'vitest';
import { router } from '@intafaced/contracts';
import { principalFor } from '../spot/testing.js';
import { payloadHash } from './common.js';
import { tradeOpsAdminRouter } from './router.js';
import type { TradeOpsAdmin } from './service.js';

const OP = '33333333-3333-4333-8333-333333333333';
const REASON = 'TEST: set the owner value for the charts pilot';

function stub() {
  const owner = {
    get: vi.fn(async (..._args: unknown[]) => ({ scalars: { version: null }, dataClasses: [] })),
    set: vi.fn(async (..._args: unknown[]) => ({ scalars: { version: '1' }, dataClasses: [] })),
  };
  const admin = { chartOwnerValues: owner } as unknown as TradeOpsAdmin;
  return { owner, caller: (scopes: string[]) => createCaller(admin, scopes) };
}

function createCaller(admin: TradeOpsAdmin, scopes: string[]) {
  const context = {
    principal: principalFor(OP, scopes),
    region: 'SG',
    service: null,
    requestId: 'ctx',
  };
  return router({ admin: tradeOpsAdminRouter(admin) }).createCaller(context as never);
}

const scalar = (key: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  key,
  value,
  expectedVersion: '0',
  reason: REASON,
  clientRequestId: 'cro-router',
  ...extra,
});

describe('data class approval payload', () => {
  it('hashes to the same golden value the admin console computes for the same change', () => {
    // Golden vector shared with apps/admin/src/lib/trade-ops/charts-owner-values-hash.test.ts. Both sides use the
    // same canonical JSON; if one changes, the approval a founder is shown no longer matches what svc-trade consumes.
    expect(
      payloadHash({
        actionType: 'trade.chart_data_class_set',
        symbol: 'BTC/USDT',
        dataClass: 'real_time',
        expectedVersion: '0',
        reason: 'list BTC for the charts pilot',
      }),
    ).toBe('sha256:d51ed1f6e5d8fc7ea6c05ea66c3ebd4f92df8647963ae67d3b53710de74a6e67');
  });
});

describe('admin.chartOwnerValues router', () => {
  it('a writer with a reason sets a count, and the service receives the parsed input', async () => {
    const { owner, caller } = stub();
    const c = caller(['admin:read', 'admin:write']);
    await c.admin.chartOwnerValues.set(scalar('compareCap', 3) as never);
    expect(owner.set).toHaveBeenCalledTimes(1);
    expect(owner.set.mock.calls[0]?.[1]).toMatchObject({ key: 'compareCap', value: 3, reason: REASON });
  });

  it('a blank count (null) is accepted as clearing back to not set', async () => {
    const { owner, caller } = stub();
    await caller(['admin:read', 'admin:write']).admin.chartOwnerValues.set(scalar('drawingCap', null) as never);
    expect(owner.set.mock.calls[0]?.[1]).toMatchObject({ key: 'drawingCap', value: null });
  });

  it('a support reader reads the page and cannot write', async () => {
    const { owner, caller } = stub();
    const reader = caller(['admin:read']);
    await expect(reader.admin.chartOwnerValues.get()).resolves.toMatchObject({ scalars: { version: null } });
    await expect(reader.admin.chartOwnerValues.set(scalar('compareCap', 3) as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      reader.admin.chartOwnerValues.set({
        key: 'dataClass',
        symbol: 'BTC/USDT',
        value: 'real_time',
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'appr-1',
        clientRequestId: 'cdc-router',
      } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(owner.set).not.toHaveBeenCalled();
  });

  it('an anonymous caller is refused', async () => {
    const { owner } = stub();
    const anonymous = router({ admin: tradeOpsAdminRouter({ chartOwnerValues: owner } as unknown as TradeOpsAdmin) }).createCaller({
      principal: null,
      region: 'SG',
      service: null,
      requestId: 'ctx',
    } as never);
    await expect(anonymous.admin.chartOwnerValues.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(owner.get).not.toHaveBeenCalled();
  });

  it('refuses a write with no reason, a short reason, or no clientRequestId before the service', async () => {
    const { owner, caller } = stub();
    const c = caller(['admin:read', 'admin:write']);
    for (const body of [
      scalar('compareCap', 3, { reason: undefined }),
      scalar('compareCap', 3, { reason: 'x' }),
      scalar('compareCap', 3, { clientRequestId: '   ' }),
      scalar('compareCap', 3, { clientRequestId: undefined }),
    ]) {
      await expect(c.admin.chartOwnerValues.set(body as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(owner.set).not.toHaveBeenCalled();
  });

  it('refuses a value of the wrong type or outside the bound', async () => {
    const { owner, caller } = stub();
    const c = caller(['admin:read', 'admin:write']);
    for (const body of [
      scalar('compareCap', '3'),
      scalar('compareCap', 2.5),
      scalar('compareCap', 0),
      scalar('compareCap', -1),
      scalar('compareCap', 51),
      scalar('chartCountLimit', 65),
      scalar('drawingCap', 10_001),
      scalar('brushPointCap', 100_001),
      scalar('delayedBoundarySeconds', 86_401),
      scalar('compareCap', true),
    ]) {
      await expect(c.admin.chartOwnerValues.set(body as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(owner.set).not.toHaveBeenCalled();
  });

  it('refuses an unknown key, and an extra field the key does not take', async () => {
    const { owner, caller } = stub();
    const c = caller(['admin:read', 'admin:write']);
    await expect(c.admin.chartOwnerValues.set(scalar('unknownCap', 3) as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.admin.chartOwnerValues.set(scalar('compareCap', 3, { approvalId: 'appr-x' }) as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(owner.set).not.toHaveBeenCalled();
  });

  it('a data class write without an approval, or with a value outside the three classes, is refused by schema', async () => {
    const { owner, caller } = stub();
    const c = caller(['admin:read', 'admin:write']);
    const dataClass = {
      key: 'dataClass',
      symbol: 'BTC/USDT',
      value: 'real_time',
      expectedVersion: '0',
      reason: REASON,
      clientRequestId: 'cdc-r',
    };
    await expect(c.admin.chartOwnerValues.set(dataClass as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.admin.chartOwnerValues.set({ ...dataClass, approvalId: 'appr-1', value: 'live' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(c.admin.chartOwnerValues.set({ ...dataClass, approvalId: '   ' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(owner.set).not.toHaveBeenCalled();
  });

  it('a data class write with a valid approval reaches the service with the approval attached', async () => {
    const { owner, caller } = stub();
    await caller(['admin:read', 'admin:write']).admin.chartOwnerValues.set({
      key: 'dataClass',
      symbol: 'BTC/USDT',
      value: 'delayed',
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'appr-1',
      clientRequestId: 'cdc-ok',
    } as never);
    expect(owner.set.mock.calls[0]?.[1]).toMatchObject({ key: 'dataClass', symbol: 'BTC/USDT', value: 'delayed', approvalId: 'appr-1' });
  });

  it('a service refusal maps to a typed BAD_REQUEST carrying the code', async () => {
    const owner = {
      get: vi.fn(async (..._args: unknown[]) => undefined),
      set: vi.fn(async (..._args: unknown[]) => {
        const { TradeOpsError } = await import('./common.js');
        throw new TradeOpsError('chart_owner_values_stale', 'expectedVersion 0 is stale; current is 1');
      }),
    };
    const c = router({ admin: tradeOpsAdminRouter({ chartOwnerValues: owner } as unknown as TradeOpsAdmin) }).createCaller({
      principal: principalFor(OP, ['admin:read', 'admin:write']),
      region: 'SG',
      service: null,
      requestId: 'ctx',
    } as never);
    await expect(c.admin.chartOwnerValues.set(scalar('compareCap', 3) as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'expectedVersion 0 is stale; current is 1',
    });
  });

  it('is unavailable when no admin service is wired', async () => {
    const c = router({ admin: tradeOpsAdminRouter(undefined) }).createCaller({
      principal: principalFor(OP, ['admin:read']),
      region: 'SG',
      service: null,
      requestId: 'ctx',
    } as never);
    await expect(c.admin.chartOwnerValues.get()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
