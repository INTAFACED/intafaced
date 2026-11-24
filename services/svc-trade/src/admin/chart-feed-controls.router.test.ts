/** J-charts-desk-19 router: the chart feed control doors refuse by schema and scope before the service. No database here. */
import { describe, expect, it, vi } from 'vitest';
import { router } from '@intafaced/contracts';
import { principalFor } from '../spot/testing.js';
import { tradeOpsAdminRouter } from './router.js';
import type { TradeOpsAdmin } from './service.js';

const OP = '33333333-3333-4333-8333-333333333333';
const REASON = 'TEST: switch the chart to the backup';

function stub() {
  const desk = {
    list: vi.fn(async () => ({ markets: [], journal: [] })),
    prepare: vi.fn(async (_p: unknown, input: unknown) => input),
    apply: vi.fn(async (_p: unknown, input: unknown) => input),
    export: vi.fn(async () => ({ rows: [] })),
  };
  // A partial fake: only the desk this router reaches.
  const admin = { chartFeedControls: desk } as never;
  const caller = (scopes: string[]) =>
    router({ admin: tradeOpsAdminRouter(admin satisfies TradeOpsAdmin) }).createCaller({
      principal: principalFor(OP, scopes),
      region: 'SG',
      service: null,
      requestId: 'ctx',
    } as never);
  return { desk, caller };
}

const change = (action: unknown) => ({ symbol: 'BTC/USDT', action, expectedVersion: '0', reason: REASON });

describe('admin.chartFeedControls router', () => {
  it('a reader lists; only a writer prepares or runs a change', async () => {
    const { desk, caller } = stub();
    await caller(['admin:read']).admin.chartFeedControls.list();
    expect(desk.list).toHaveBeenCalledTimes(1);
    await expect(caller(['admin:read']).admin.chartFeedControls.prepare(change({ kind: 'disable' }) as never)).rejects.toThrow();
    expect(desk.prepare).not.toHaveBeenCalled();
  });

  it('passes the tagged action through; a switch with no source, or an unknown action, is refused by schema', async () => {
    const { desk, caller } = stub();
    const w = caller(['admin:read', 'admin:write']).admin.chartFeedControls;
    await w.prepare(change({ kind: 'switch_source', to: 'test-backup' }) as never);
    expect(desk.prepare.mock.calls[0]![1]).toMatchObject({ action: { kind: 'switch_source', to: 'test-backup' } });
    await expect(w.prepare(change({ kind: 'switch_source' }) as never)).rejects.toThrow();
    await expect(w.prepare(change({ kind: 'halt' }) as never)).rejects.toThrow();
    await expect(w.prepare(change({ kind: 'disable', to: 'x' }) as never)).rejects.toThrow();
    expect(desk.prepare).toHaveBeenCalledTimes(1);
  });

  it('a run needs the approval id and its operation id', async () => {
    const { desk, caller } = stub();
    const w = caller(['admin:read', 'admin:write']).admin.chartFeedControls;
    await expect(w.run(change({ kind: 'disable' }) as never)).rejects.toThrow();
    await w.run({ ...change({ kind: 'disable' }), approvalId: 'ap-1', operationId: 'op-1' } as never);
    expect(desk.apply.mock.calls[0]![1]).toMatchObject({ approvalId: 'ap-1', operationId: 'op-1', action: { kind: 'disable' } });
  });
});
