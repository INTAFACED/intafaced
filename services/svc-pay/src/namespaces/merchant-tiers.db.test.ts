import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { MerchantControlError } from '../merchant-account-controls.js';
import { RailRegistry } from '../rails/registry.js';
import { teamAccessPorts } from '../control/access.js';
import { ChangeService } from '../control/changes.js';
import { ControlService } from '../control/service.js';
import {
  applyChange,
  FOUNDER_1,
  FOUNDER_2,
  migrations,
  openAdmin,
  OWNER_A,
  OWNER_B,
  principal,
  resetControl,
  TEST_GLOBAL_RULE,
  TEST_TIER,
} from '../control/control.testkit.js';
import { loadHaltAutoTripConfig } from '../halts/config.js';
import { PayHaltStore } from '../halts/store.js';
import { createMetricsRuntime, type MetricsRuntime } from '../metrics/index.js';
import { createPayNamespaces } from './index.js';

/**
 * Merchant tier catalogue, pricing history and limit-increase requests, plus the
 * founder drill-down that reads them. Every money figure in here is a TEST VALUE.
 * A limit request must not change the caps the profile already has.
 */
describe('merchant tiers, pricing history, limit requests, founder drill-down', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;
  let metrics!: MetricsRuntime;
  let store!: PayHaltStore;
  let changes!: ChangeService;
  let merchantA = '';
  let merchantB = '';
  const FOUNDERS = new Set([FOUNDER_1, FOUNDER_2]);
  const window = { kind: 'preset', preset: 'today' } as const;
  const FINANCE = '55555555-5555-4555-8555-555555555555';
  const DEVELOPER = '66666666-6666-4666-8666-666666666666';

  const founderAuthority = async (ctx: Context): Promise<string> => {
    const p = ctx.principal;
    if (ctx.service || !p || !p.mfa || (p as { kid?: string }).kid || !FOUNDERS.has(p.userId)) {
      throw new MerchantControlError('operator.denied');
    }
    return p.userId;
  };
  const ctxOf = (userId: string | null): Context => ({
    principal: userId ? principal(userId) : null,
    service: null,
    region: 'DE',
    requestId: randomUUID(),
  });
  type Call = (input: unknown) => Promise<unknown>;
  const at = (caller: unknown, path: string): Call => path.split('.').reduce((n, k) => (n as Record<string, unknown>)[k], caller) as Call;
  const mounted = () =>
    createPayNamespaces({
      founderAuthority,
      control: new ControlService(sql, teamAccessPorts(sql)),
      metrics,
      payHalts: { store, merchants: pay },
    });
  const failure = async (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: { code: string; message: string; cause?: { code?: string } }) => ({ code: e.code, message: e.message, cause: e.cause?.code }),
    );

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    metrics = createMetricsRuntime({ sql, pay, trees: null, rails: { health: () => [] } });
    store = new PayHaltStore(sql, loadHaltAutoTripConfig({}));
    changes = new ChangeService(sql);
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    merchantA = (
      await pay.createMerchant({
        userId: OWNER_A,
        pricing: { feeBps: 0 },
        displayName: 'Acme Shop',
        legalName: 'Acme Trading Ltd',
        status: 'active',
        kybStatus: 'approved',
      })
    ).id;
    merchantB = (await pay.createMerchant({ userId: OWNER_B, pricing: { feeBps: 0 }, status: 'active' })).id;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function assignTier() {
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: merchantA,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
  }

  it('an empty tier catalogue is not configured, and a configured catalogue does not invent founder-only fields', async () => {
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const empty = await at(owner, 'merchantControl.tiers.list')({ merchantId: merchantA });
    expect(empty).toEqual({ status: 'not_configured', ownTierId: null });
    expect(JSON.stringify(empty)).not.toContain('starter');

    await assignTier();
    const listed = (await at(owner, 'merchantControl.tiers.list')({ merchantId: merchantA })) as {
      status: string;
      ownTierId: string;
      tiers: Array<Record<string, unknown>>;
    };
    expect(listed.status).toBe('configured');
    expect(listed.ownTierId).toBe(TEST_TIER.id);
    expect(listed.tiers.map((tier) => tier.id)).toEqual([TEST_TIER.id]);
    expect(Object.keys(listed.tiers[0]!).sort()).toEqual(['archetype', 'caps', 'id', 'name', 'reserve', 'version']);
    const other = (await at(mounted().createCaller(ctxOf(OWNER_B)), 'merchantControl.tiers.list')({ merchantId: merchantB })) as {
      ownTierId: string | null;
    };
    expect(other.ownTierId).toBeNull();
  });

  it("merchant A cannot read merchant B's catalogue or a missing id, and a developer on the team cannot either", async () => {
    await assignTier();
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantA}, ${DEVELOPER}, 'developer', 'active', ${OWNER_A}, now())
    `;
    const missing = randomUUID();
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const foreign = await failure(at(owner, 'merchantControl.tiers.list')({ merchantId: merchantB }));
    const absent = await failure(at(owner, 'merchantControl.tiers.list')({ merchantId: missing }));
    expect(foreign).toEqual(absent);
    expect(foreign).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.merchant_not_found' });
    const developer = mounted().createCaller(ctxOf(DEVELOPER));
    const asDev = await failure(at(developer, 'merchantControl.tiers.list')({ merchantId: merchantA }));
    const devMissing = await failure(at(developer, 'merchantControl.tiers.list')({ merchantId: missing }));
    expect(asDev).toEqual(devMissing);
    expect(asDev).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.merchant_not_found' });
  });

  it('pricing history is not configured until a rule exists, then shows this merchant’s rules including a superseded one', async () => {
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    expect(await at(owner, 'merchantControl.pricing.history')({ merchantId: merchantA, limit: 20 })).toEqual({
      status: 'not_configured',
      events: [],
    });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: {
        kind: 'set_pricing_layer',
        layer: 'global',
        scopeId: null,
        rules: [{ ...TEST_GLOBAL_RULE, bands: [{ fromAmount: '0', feeBps: 260, flatFee: '0.3' }] }],
      },
    });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: {
        kind: 'set_pricing_layer',
        layer: 'merchant',
        scopeId: merchantA,
        rules: [
          {
            assetCode: 'USDT',
            bands: [{ fromAmount: '0', feeBps: 100, flatFee: null }],
            spreadBps: null,
            roundingBeneficiary: 'merchant',
          },
        ],
      },
    });
    const history = (await at(owner, 'merchantControl.pricing.history')({ merchantId: merchantA, limit: 20 })) as {
      status: string;
      events: Array<{
        layer: string;
        scopeId: string | null;
        feeBps?: number;
        bands: Array<{ feeBps: number }>;
        supersededAt: string | null;
      }>;
    };
    expect(history.status).toBe('configured');
    const globalEvents = history.events.filter((event) => event.layer === 'global');
    expect(globalEvents).toHaveLength(2);
    expect(globalEvents.filter((event) => event.supersededAt !== null)).toHaveLength(1);
    expect(history.events.some((event) => event.layer === 'merchant' && event.scopeId === merchantA)).toBe(true);
    const other = (await at(
      mounted().createCaller(ctxOf(OWNER_B)),
      'merchantControl.pricing.history',
    )({
      merchantId: merchantB,
      limit: 20,
    })) as { events: Array<{ scopeId: string | null }> };
    expect(other.events.every((event) => event.scopeId !== merchantA)).toBe(true);
    const leaked = await failure(
      at(mounted().createCaller(ctxOf(OWNER_B)), 'merchantControl.pricing.history')({ merchantId: merchantA, limit: 20 }),
    );
    const missing = await failure(
      at(mounted().createCaller(ctxOf(OWNER_B)), 'merchantControl.pricing.history')({ merchantId: randomUUID(), limit: 20 }),
    );
    expect(leaked).toEqual(missing);
  });

  it('a limit increase is stored, idempotent, and does not change caps', async () => {
    await assignTier();
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const before = (await at(owner, 'merchantControl.get')({ merchantId: merchantA })) as { caps: unknown; version: string };
    const asked = [{ kind: 'per_payment' as const, assetCode: 'USDT', limit: '999' }];
    const firstId = randomUUID();
    const stored = (await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId: firstId,
      caps: asked,
      reason: 'TEST VALUE ask, not a cap',
    })) as { outcome: string; requestId: string; caps: Array<{ limit: string }> };
    expect(stored).toMatchObject({ outcome: 'stored', requestId: firstId, caps: asked });
    const again = (await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId: randomUUID(),
      caps: [{ kind: 'daily_payout', assetCode: 'USDT', limit: '1' }],
      reason: 'a different ask',
    })) as { outcome: string; requestId: string; caps: Array<{ limit: string }> };
    expect(again).toMatchObject({ outcome: 'already_open', requestId: firstId, caps: asked });
    expect(await sql`SELECT 1 FROM pay.control_limit_requests WHERE merchant_id = ${merchantA}`).toHaveLength(1);
    const after = (await at(owner, 'merchantControl.get')({ merchantId: merchantA })) as { caps: unknown; version: string };
    expect(after).toEqual(before);
    const [profile] = await sql<Array<{ caps_override: unknown }>>`
      SELECT caps_override FROM pay.control_merchant_profiles WHERE merchant_id = ${merchantA}
    `;
    expect(profile?.caps_override).toBeNull();
    expect(await at(owner, 'merchantControl.limits.open')({ merchantId: merchantA })).toMatchObject({
      status: 'pending',
      request: { requestId: firstId, caps: asked },
    });
    expect(await at(mounted().createCaller(ctxOf(OWNER_B)), 'merchantControl.limits.open')({ merchantId: merchantB })).toEqual({
      status: 'none',
    });

    const bad = await failure(
      at(
        owner,
        'merchantControl.limits.requestIncrease',
      )({
        merchantId: merchantA,
        requestId: randomUUID(),
        caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: 10 }],
        reason: 'numeric money',
      }),
    );
    expect(bad?.code).toBe('BAD_REQUEST');

    await expect(sql`UPDATE pay.control_limit_requests SET reason = 'rewritten'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM pay.control_limit_requests`).rejects.toThrow(/append-only/);
  });

  it('two concurrent asks leave one pending row', async () => {
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const ask = (requestId: string) =>
      at(
        owner,
        'merchantControl.limits.requestIncrease',
      )({
        merchantId: merchantA,
        requestId,
        caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '10' }],
        reason: 'TEST VALUE concurrent ask',
      }) as Promise<{ outcome: string }>;
    const [left, right] = await Promise.all([ask(randomUUID()), ask(randomUUID())]);
    expect([left.outcome, right.outcome].sort()).toEqual(['already_open', 'stored']);
    expect(await sql`SELECT 1 FROM pay.control_limit_requests WHERE merchant_id = ${merchantA}`).toHaveLength(1);
  });

  it('founders see the pending ask, and a merchant session cannot', async () => {
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const requestId = randomUUID();
    await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId,
      caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '10' }],
      reason: 'please review',
    });
    await at(
      mounted().createCaller(ctxOf(OWNER_B)),
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantB,
      requestId: randomUUID(),
      caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '11' }],
      reason: 'B asks too',
    });
    const founder = mounted().createCaller(ctxOf(FOUNDER_1));
    const page = (await at(founder, 'founderAdmin.control.limitRequests.list')({ limit: 1 })) as {
      requests: Array<{ merchantId: string }>;
      nextCursor: string | null;
    };
    expect(page.requests).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const rest = (await at(founder, 'founderAdmin.control.limitRequests.list')({ limit: 10, cursor: page.nextCursor })) as {
      requests: Array<{ merchantId: string }>;
      nextCursor: string | null;
    };
    expect(rest.nextCursor).toBeNull();
    expect([...page.requests, ...rest.requests].map((row) => row.merchantId).sort()).toEqual([merchantA, merchantB].sort());
    const refused = await failure(at(owner, 'founderAdmin.control.limitRequests.list')({ limit: 10 }));
    expect(refused?.code).toBe('FORBIDDEN');
    const hidden = await failure(at(owner, 'merchantControl.limits.open')({ merchantId: merchantB }));
    const missing = await failure(at(owner, 'merchantControl.limits.open')({ merchantId: randomUUID() }));
    expect(hidden).toEqual(missing);
  });

  it('a finance member of A can read A and cannot read B', async () => {
    await assignTier();
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantA}, ${FINANCE}, 'finance', 'active', ${OWNER_A}, now())
    `;
    const finance = mounted().createCaller(ctxOf(FINANCE));
    const own = await at(finance, 'merchantControl.tiers.list')({ merchantId: merchantA });
    expect(own).toMatchObject({ status: 'configured', ownTierId: TEST_TIER.id });
    const foreign = await failure(at(finance, 'merchantControl.tiers.list')({ merchantId: merchantB }));
    const missing = await failure(at(finance, 'merchantControl.tiers.list')({ merchantId: randomUUID() }));
    expect(foreign).toEqual(missing);
  });

  it('drill-down stays not built until metrics, control and the halt store are all mounted', async () => {
    const partial = createPayNamespaces({
      founderAuthority,
      control: new ControlService(sql, teamAccessPorts(sql)),
    });
    const err = await failure(
      at(partial.createCaller(ctxOf(FOUNDER_1)), 'founderAdmin.merchants.drilldown')({ merchantId: merchantA, window }),
    );
    expect(err).toMatchObject({ code: 'NOT_IMPLEMENTED', cause: 'pay.not_built' });
  });

  it('the founder drill-down reads one merchant and does not show another merchant’s halt or apply the limit ask', async () => {
    await assignTier();
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const before = await at(owner, 'merchantControl.get')({ merchantId: merchantA });
    await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId: randomUUID(),
      caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '999' }],
      reason: 'TEST VALUE ask, not a cap',
    });
    await store.set(FOUNDER_1, {
      requestId: randomUUID(),
      scope: 'payout',
      target: { level: 'merchant', merchantId: merchantB },
      halted: true,
      reason: 'stop B payouts',
      expectedVersion: '0',
    });
    const founder = mounted().createCaller(ctxOf(FOUNDER_1));
    const view = (await at(founder, 'founderAdmin.merchants.drilldown')({ merchantId: merchantA, window })) as {
      displayName: string;
      legalName: string;
      status: string;
      control: { tierId: string | null; caps: Array<{ limit?: string }> | null };
      metrics: { paymentCount: number; settlements: unknown[] };
      halts: { readable: boolean; states: Array<{ target: { level: string; merchantId?: string } }> };
      pendingLimitRequests: Array<{ caps: Array<{ limit: string }> }>;
      recentAudit: Array<{ kind: string }>;
      operator: { kybStatus: string; parentMerchantId: string | null };
    };
    expect(view.displayName).toBe('Acme Shop');
    expect(view.legalName).toBe('Acme Trading Ltd');
    expect(view.status).toBe('active');
    expect(view.operator).toMatchObject({ kybStatus: 'approved', parentMerchantId: null });
    expect(view.control.tierId).toBe(TEST_TIER.id);
    expect(view.control.caps?.some((cap) => cap.limit === '999')).toBe(false);
    expect(view.metrics.paymentCount).toBe(0);
    expect(view.metrics.settlements).toEqual([]);
    expect(view.halts.readable).toBe(true);
    expect(view.halts.states.some((state) => state.target.level === 'merchant' && state.target.merchantId === merchantB)).toBe(false);
    expect(view.pendingLimitRequests.map((request) => request.caps[0]?.limit)).toEqual(['999']);
    expect(view.recentAudit.some((event) => event.kind === 'limit.increase_requested')).toBe(true);
    expect(await at(owner, 'merchantControl.get')({ merchantId: merchantA })).toEqual(before);
    const missing = await failure(at(founder, 'founderAdmin.merchants.drilldown')({ merchantId: randomUUID(), window }));
    expect(missing).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.merchant_not_found' });
    const merchant = await failure(at(owner, 'founderAdmin.merchants.drilldown')({ merchantId: merchantA, window }));
    expect(merchant?.code).toBe('FORBIDDEN');
  });
});
