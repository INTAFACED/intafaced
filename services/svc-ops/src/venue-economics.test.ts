import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, OPS_COST_CATEGORIES, type ActionApproval } from '@intafaced/contracts';
import {
  OPS_APPROVAL_UNWIRED,
  OPS_COST_AMOUNT_INVALID,
  OPS_COST_CATEGORY_INVALID,
  OPS_COST_PERIOD_INVALID,
  OPS_COST_STORAGE_UNCONFIGURED,
  OPS_IDEMPOTENCY_CONFLICT,
  OPS_WAREHOUSE_UNWIRED,
} from './codes.js';
import { migrateOutreach } from './db/migrate.js';
import { OpsService } from './ops-service.js';
import { createOpsRouter } from './router.js';
import {
  costFingerprint,
  createMemoryVenueCostStore,
  createPgVenueCostStore,
  trimDecimal,
  type VenueCostStore,
} from './venue-cost-store.js';
import { addDecimalStrings, composeVenueEconomics } from './venue-economics.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

function principal(scopes: string[]): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

async function signed(scopes: string[]) {
  const raw = encodePrincipal(principal(scopes));
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function approvals() {
  let calls = 0;
  return {
    calls: () => calls,
    async consume(input: {
      approvalId: string;
      operationId: string;
      payloadHash: string;
      targetService: string;
      targetId: string;
      expectedVersion: string;
    }): Promise<ActionApproval> {
      calls += 1;
      return {
        ...input,
        actionType: 'ops.venue_cost.record',
        requesterId: USER,
        approverId: APPROVER,
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'v1',
        createdAt: '2026-10-20T00:00:00.000Z',
        expiresAt: '2026-10-20T00:10:00.000Z',
        status: 'CONSUMED',
      };
    },
  };
}

const body = (over: Record<string, string> = {}) => ({
  period: '2026-10',
  category: 'custody',
  amount: '100.5',
  asset: 'USD',
  sourceNote: 'TEST invoice 1',
  idempotencyKey: 'venue-cost-key-1',
  approvalId: 'appr-1',
  operationId: 'op-1',
  ...over,
});

async function api(opts: { store?: VenueCostStore; approver?: ReturnType<typeof approvals>; scopes?: string[] } = {}) {
  const approver = opts.approver ?? approvals();
  const caller = createOpsRouter(new OpsService(), undefined, {
    now: () => '2026-10-20T10:00:00.000Z',
    ...(opts.store ? { venueCosts: opts.store } : {}),
    approvals: approver,
  }).createCaller(await signed(opts.scopes ?? ['admin:read', 'admin:write']));
  return { caller, approver };
}

const refuses = (code: string) => ({ code: 'PRECONDITION_FAILED', message: expect.stringContaining(code) });

describe('composeVenueEconomics', () => {
  const entry = (category: (typeof OPS_COST_CATEGORIES)[number], amount: string, version = 1, asset = 'USD') => ({
    key: `venue-cost:2026-10:${category}:${version}`,
    period: '2026-10',
    category,
    version,
    amount,
    asset,
    sourceNote: 'TEST',
    enteredBy: 'a',
    approverId: 'b',
    enteredAt: '2026-10-20T00:00:00.000Z',
  });
  const revenue = {
    ok: true as const,
    value: {
      empty: false,
      status: 'ok' as const,
      mayLabelLive: false,
      freshness: 'fresh',
      points: [{ metricId: 'fee_revenue', value: '1000', dim: null }],
    },
  };

  it('is incomplete with five of seven categories: names the two missing and gives no net', () => {
    const five = OPS_COST_CATEGORIES.slice(0, 5).map((c) => entry(c, '10'));
    const report = composeVenueEconomics('t', '2026-10', revenue, five);
    expect(report.completeness).toEqual({ status: 'incomplete', missing: ['compliance', 'infrastructure'] });
    expect(report.costs.filter((c) => c.status === 'not_entered').map((c) => c.category)).toEqual(['compliance', 'infrastructure']);
    expect(report.costTotals).toEqual({ partial: true, byAsset: [{ asset: 'USD', amount: '50' }] });
    expect(report.net).toEqual({ status: 'unavailable', reason: 'revenue_asset_unknown' });
    expect(report.revenue).toMatchObject({ status: 'ok', points: [{ metricId: 'fee_revenue', value: '1000' }] });
  });

  it('never zero-fills: no entries gives not_entered everywhere and an empty total', () => {
    const report = composeVenueEconomics('t', '2026-10', revenue, []);
    expect(report.costs.map((c) => c.category)).toEqual([...OPS_COST_CATEGORIES]);
    expect(report.costs.every((c) => c.status === 'not_entered')).toBe(true);
    expect(report.costTotals).toEqual({ partial: true, byAsset: [] });
  });

  it('uses the latest version as current and keeps the history; is complete with all seven', () => {
    const all = OPS_COST_CATEGORIES.map((c) => entry(c, '1.25'));
    const report = composeVenueEconomics('t', '2026-10', revenue, [...all, entry('custody', '2.5', 2)]);
    const custody = report.costs.find((c) => c.category === 'custody');
    expect(custody).toMatchObject({ status: 'entered', current: { version: 2, amount: '2.5' } });
    expect(custody?.status === 'entered' && custody.history.map((h) => h.version)).toEqual([1, 2]);
    expect(report.completeness).toEqual({ status: 'complete' });
    expect(report.costTotals).toEqual({ partial: false, byAsset: [{ asset: 'USD', amount: '10' }] });
  });

  it('totals per asset without mixing units, exactly on decimals', () => {
    const report = composeVenueEconomics('t', '2026-10', revenue, [
      entry('data', '0.1'),
      entry('support', '0.2'),
      entry('custody', '3', 1, 'EUR'),
    ]);
    expect(report.costTotals.byAsset).toEqual([
      { asset: 'EUR', amount: '3' },
      { asset: 'USD', amount: '0.3' },
    ]);
  });

  it('carries the typed warehouse code when revenue is unavailable and still lists the costs', () => {
    const report = composeVenueEconomics('t', '2026-10', { ok: false, code: OPS_WAREHOUSE_UNWIRED, message: 'unwired' }, [
      entry('data', '4'),
    ]);
    expect(report.revenue).toEqual({ status: 'unavailable', code: OPS_WAREHOUSE_UNWIRED, message: 'unwired' });
    expect(report.costs.find((c) => c.category === 'data')).toMatchObject({ status: 'entered' });
  });
});

describe('ops.venueEconomics and ops.recordVenueCost', () => {
  it('refuses without storage, before any approval is spent', async () => {
    const { caller, approver } = await api();
    await expect(caller.recordVenueCost(body())).rejects.toMatchObject(refuses(OPS_COST_STORAGE_UNCONFIGURED));
    await expect(caller.venueEconomics({ period: '2026-10' })).rejects.toMatchObject(refuses(OPS_COST_STORAGE_UNCONFIGURED));
    expect(approver.calls()).toBe(0);
  });

  it('refuses bad category, amount and period with their own codes, before any approval', async () => {
    const { caller, approver } = await api({ store: createMemoryVenueCostStore() });
    await expect(caller.recordVenueCost(body({ category: 'rent' }))).rejects.toMatchObject(refuses(OPS_COST_CATEGORY_INVALID));
    await expect(caller.recordVenueCost(body({ amount: '-5' }))).rejects.toMatchObject(refuses(OPS_COST_AMOUNT_INVALID));
    await expect(caller.recordVenueCost(body({ amount: '' }))).rejects.toMatchObject(refuses(OPS_COST_AMOUNT_INVALID));
    await expect(caller.recordVenueCost(body({ period: '2026-13' }))).rejects.toMatchObject(refuses(OPS_COST_PERIOD_INVALID));
    await expect(caller.venueEconomics({ period: 'october' })).rejects.toMatchObject(refuses(OPS_COST_PERIOD_INVALID));
    expect(approver.calls()).toBe(0);
  });

  it('needs admin:write to enter and admin:read to read; an ordinary session scope sees nothing', async () => {
    const store = createMemoryVenueCostStore();
    const reader = (await api({ store, scopes: ['admin:read'] })).caller;
    await expect(reader.recordVenueCost(body())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const writer = (await api({ store, scopes: ['admin:write'] })).caller;
    await expect(writer.venueEconomics({ period: '2026-10' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ordinary = (await api({ store, scopes: ['ops:read', 'ops:write'] })).caller;
    await expect(ordinary.venueEconomics({ period: '2026-10' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(ordinary.recordVenueCost(body())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses an amount the column cannot hold or that would be stored differently, before any approval', async () => {
    const { caller, approver } = await api({ store: createMemoryVenueCostStore() });
    for (const amount of ['123456789012345678901', '007', '00.5', '1e5', '1.', '.5']) {
      await expect(caller.recordVenueCost(body({ amount }))).rejects.toMatchObject(refuses(OPS_COST_AMOUNT_INVALID));
    }
    expect(approver.calls()).toBe(0);
    await expect(caller.recordVenueCost(body({ amount: '12345678901234567890.123456789012345678' }))).resolves.toMatchObject({
      amount: '12345678901234567890.123456789012345678',
    });
  });

  it('refuses an entry when identity is not wired, and stores nothing', async () => {
    const store = createMemoryVenueCostStore();
    const caller = createOpsRouter(new OpsService(), undefined, { venueCosts: store }).createCaller(
      await signed(['admin:read', 'admin:write']),
    );
    await expect(caller.recordVenueCost(body())).rejects.toMatchObject(refuses(OPS_APPROVAL_UNWIRED));
    expect(await store.list('2026-10')).toEqual([]);
  });

  it('records an entry, replays a retry without a second approval, and conflicts a different body', async () => {
    const { caller, approver } = await api({ store: createMemoryVenueCostStore() });
    const first = await caller.recordVenueCost(body());
    expect(first).toMatchObject({
      key: 'venue-cost:2026-10:custody:1',
      version: 1,
      amount: '100.5',
      enteredBy: USER,
      approverId: APPROVER,
    });
    expect(await caller.recordVenueCost(body())).toEqual(first);
    expect(approver.calls()).toBe(1);
    await expect(caller.recordVenueCost(body({ amount: '101' }))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a superseding entry becomes current, the history shows both, and the report stays incomplete with warehouse unwired', async () => {
    const { caller } = await api({ store: createMemoryVenueCostStore() });
    await caller.recordVenueCost(body());
    const second = await caller.recordVenueCost(
      body({ amount: '90', idempotencyKey: 'venue-cost-key-2', approvalId: 'appr-2', operationId: 'op-2' }),
    );
    expect(second).toMatchObject({ key: 'venue-cost:2026-10:custody:2', version: 2 });
    const report = await caller.venueEconomics({ period: '2026-10' });
    expect(report.revenue).toMatchObject({ status: 'unavailable', code: OPS_WAREHOUSE_UNWIRED });
    const custody = report.costs.find((c) => c.category === 'custody');
    expect(custody).toMatchObject({ status: 'entered', current: { amount: '90', version: 2 } });
    expect(custody?.status === 'entered' && custody.history.map((h) => h.amount)).toEqual(['100.5', '90']);
    expect(report.completeness.status).toBe('incomplete');
    expect(report.costTotals).toEqual({ partial: true, byAsset: [{ asset: 'USD', amount: '90' }] });
  });

  it('reads another period as untouched', async () => {
    const { caller } = await api({ store: createMemoryVenueCostStore() });
    await caller.recordVenueCost(body());
    const other = await caller.venueEconomics({ period: '2026-09' });
    expect(other.costs.every((c) => c.status === 'not_entered')).toBe(true);
  });
});

describe('trimDecimal', () => {
  it('shortens numeric(38,18) text', () => {
    expect(trimDecimal('100.500000000000000000')).toBe('100.5');
    expect(trimDecimal('0.000000000000000000')).toBe('0');
    expect(trimDecimal('7')).toBe('7');
  });
});

function storeContract(name: string, open: () => Promise<{ store: VenueCostStore; close: () => Promise<void> }>) {
  describe(name, () => {
    const fields = (amount: string, category: 'custody' | 'data' = 'custody') => ({
      period: '2026-10',
      category,
      amount,
      asset: 'USD',
      sourceNote: 'TEST',
    });
    const actors = { enteredBy: 'a', approverId: 'b', enteredAt: '2026-10-20T00:00:00.000Z' };

    it('versions per period and category, replays a key, conflicts a changed body', async () => {
      const { store, close } = await open();
      try {
        const fp1 = costFingerprint({ n: 1 });
        expect(await store.find('cost-key-0001', fp1)).toBeNull();
        const v1 = await store.append('cost-key-0001', fp1, fields('1.5'), actors);
        expect(v1).toMatchObject({ version: 1, amount: '1.5', key: 'venue-cost:2026-10:custody:1' });
        expect(await store.append('cost-key-0001', fp1, fields('1.5'), actors)).toEqual(v1);
        await expect(store.find('cost-key-0001', costFingerprint({ n: 2 }))).rejects.toMatchObject({ code: OPS_IDEMPOTENCY_CONFLICT });
        const v2 = await store.append('cost-key-0002', costFingerprint({ n: 2 }), fields('2'), actors);
        expect(v2.version).toBe(2);
        const other = await store.append('cost-key-0003', costFingerprint({ n: 3 }), fields('9', 'data'), actors);
        expect(other.version).toBe(1);
        expect((await store.list('2026-10')).map((e) => `${e.category}:${e.version}`)).toEqual(['custody:1', 'custody:2', 'data:1']);
        expect(await store.list('2026-09')).toEqual([]);
      } finally {
        await close();
      }
    });

    it('gives racing writers distinct versions', async () => {
      const { store, close } = await open();
      try {
        const rows = await Promise.all(
          [1, 2, 3, 4].map((n) => store.append(`race-key-000${n}`, costFingerprint({ n }), fields(String(n)), actors)),
        );
        expect(rows.map((r) => r.version).sort()).toEqual([1, 2, 3, 4]);
      } finally {
        await close();
      }
    });
  });
}

storeContract('memory venue cost store', async () => ({ store: createMemoryVenueCostStore(), close: async () => undefined }));

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('durable venue costs on real PostgreSQL', () => {
  const open = async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 6, onnotice: () => undefined });
    await migrateOutreach(sql);
    return {
      sql,
      store: createPgVenueCostStore(sql),
      close: async () => {
        await sql.end();
        await database.drop();
      },
    };
  };
  storeContract('postgres venue cost store', open);

  it('refuses to change or delete an entry, a negative amount and an unknown category', async () => {
    const { sql, store, close } = await open();
    try {
      await store.append(
        'cost-key-0001',
        costFingerprint({}),
        { period: '2026-10', category: 'data', amount: '1', asset: 'USD', sourceNote: 'TEST' },
        {
          enteredBy: 'a',
          approverId: 'b',
          enteredAt: '2026-10-20T00:00:00.000Z',
        },
      );
      await expect(sql`UPDATE ops.venue_cost_entries SET source_note='x'`).rejects.toThrow(/venue_cost_entry_immutable/);
      await expect(sql`DELETE FROM ops.venue_cost_entries`).rejects.toThrow(/venue_cost_entry_immutable/);
      await expect(
        sql`INSERT INTO ops.venue_cost_entries (idempotency_key,fingerprint,period,category,version,amount,asset,source_note,entered_by,approver_id)
          VALUES ('cost-key-0009',${costFingerprint({})},'2026-10','data',2,-1,'USD','x','a','b')`,
      ).rejects.toThrow();
      await expect(
        sql`INSERT INTO ops.venue_cost_entries (idempotency_key,fingerprint,period,category,version,amount,asset,source_note,entered_by,approver_id)
          VALUES ('cost-key-0010',${costFingerprint({})},'2026-10','rent',1,1,'USD','x','a','b')`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});

describe('addDecimalStrings', () => {
  it('adds exactly, with carries and uneven fractions', () => {
    expect(addDecimalStrings('0', '0')).toBe('0');
    expect(addDecimalStrings('0.1', '0.2')).toBe('0.3');
    expect(addDecimalStrings('999.99', '0.01')).toBe('1000');
    expect(addDecimalStrings('1250.5', '0.000000000000000001')).toBe('1250.500000000000000001');
    expect(addDecimalStrings('12345678901234567890123456789', '1')).toBe('12345678901234567890123456790');
    expect(addDecimalStrings('007', '3')).toBe('10');
  });
});
