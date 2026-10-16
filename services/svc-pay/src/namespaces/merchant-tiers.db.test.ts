import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
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
  const ctxOf = (userId: string | null, over: Record<string, unknown> = {}): Context => ({
    principal: userId ? principal(userId, over) : null,
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
    await applyChange(changes, sql, {
      scope: 'tier',
      change: { kind: 'upsert_tier', tier: { ...TEST_TIER, id: 'other-tier', name: 'TEST VALUE other tier' } },
    });
    const listed = (await at(owner, 'merchantControl.tiers.list')({ merchantId: merchantA })) as {
      status: string;
      ownTierId: string;
      tiers: Array<Record<string, unknown>>;
    };
    expect(listed.status).toBe('configured');
    expect(listed.ownTierId).toBe(TEST_TIER.id);
    expect(listed.tiers.map((tier) => tier.id)).toEqual([TEST_TIER.id]);
    expect(JSON.stringify(listed)).not.toContain('other-tier');
    expect(Object.keys(listed.tiers[0]!).sort()).toEqual(['archetype', 'caps', 'id', 'name', 'reserve', 'version']);
    const other = await at(mounted().createCaller(ctxOf(OWNER_B)), 'merchantControl.tiers.list')({ merchantId: merchantB });
    expect(other).toEqual({ status: 'not_configured', ownTierId: null });
    expect(JSON.stringify(other)).not.toContain('test-tier');
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

    await expect(sql`UPDATE pay.control_limit_requests SET reason = 'rewritten'`).rejects.toThrow(/immutable/);
    await expect(sql`DELETE FROM pay.control_limit_requests`).rejects.toThrow(/immutable/);
    const [still] = await sql<Array<{ reason: string; status: string }>>`
      SELECT reason, status FROM pay.control_limit_requests WHERE request_id = ${firstId}
    `;
    expect(still).toEqual({ reason: 'TEST VALUE ask, not a cap', status: 'pending' });
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

  it('drill-down matches a merchant id regardless of letter case', async () => {
    const founder = mounted().createCaller(ctxOf(FOUNDER_1));
    const view = (await at(
      founder,
      'founderAdmin.merchants.drilldown',
    )({
      merchantId: merchantA.toUpperCase(),
      window,
    })) as { merchantId: string; displayName: string };
    expect(view.merchantId).toBe(merchantA.toLowerCase());
    expect(view.displayName).toBe('Acme Shop');
  });

  it('only an interactive owner, admin or finance member can ask or withdraw', async () => {
    const ADMIN = '77777777-7777-4777-8777-777777777777';
    const VIEWER = '88888888-8888-4888-8888-888888888888';
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES
        (${merchantA}, ${FINANCE}, 'finance', 'active', ${OWNER_A}, now()),
        (${merchantA}, ${ADMIN}, 'admin', 'active', ${OWNER_A}, now()),
        (${merchantA}, ${DEVELOPER}, 'developer', 'active', ${OWNER_A}, now()),
        (${merchantA}, ${VIEWER}, 'viewer', 'active', ${OWNER_A}, now())
    `;
    const caps = [{ kind: 'per_payment' as const, assetCode: 'USDT', limit: '10' }];
    const body = (merchantId: string) => ({
      merchantId,
      requestId: randomUUID(),
      caps,
      reason: 'TEST VALUE ask, not a cap',
    });
    const finance = mounted().createCaller(ctxOf(FINANCE));
    const stored = (await at(finance, 'merchantControl.limits.requestIncrease')(body(merchantA))) as { outcome: string; requestId: string };
    expect(stored.outcome).toBe('stored');
    const withdrawn = (await at(
      finance,
      'merchantControl.limits.withdraw',
    )({
      merchantId: merchantA,
      requestId: stored.requestId,
      reason: 'finance takes it back',
    })) as { status: string; requestId: string; closeReason: string };
    expect(withdrawn).toMatchObject({ status: 'withdrawn', requestId: stored.requestId, closeReason: 'finance takes it back' });

    const admin = mounted().createCaller(ctxOf(ADMIN));
    const again = (await at(admin, 'merchantControl.limits.requestIncrease')(body(merchantA))) as { outcome: string; requestId: string };
    expect(again.outcome).toBe('stored');
    expect(
      await at(
        admin,
        'merchantControl.limits.withdraw',
      )({ merchantId: merchantA, requestId: again.requestId, reason: 'admin takes it back' }),
    ).toMatchObject({ status: 'withdrawn' });

    const missing = randomUUID();
    for (const userId of [DEVELOPER, VIEWER]) {
      const caller = mounted().createCaller(ctxOf(userId));
      const askForeign = await failure(at(caller, 'merchantControl.limits.requestIncrease')(body(merchantA)));
      const askMissing = await failure(at(caller, 'merchantControl.limits.requestIncrease')(body(missing)));
      expect(askForeign).toEqual(askMissing);
      expect(askForeign).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.merchant_not_found' });
    }

    const keyBody = body(merchantA);
    const ownKey = await failure(
      at(mounted().createCaller(ctxOf(OWNER_A, { kid: 'ifc_owner' })), 'merchantControl.limits.requestIncrease')(keyBody),
    );
    const foreignKey = await failure(
      at(mounted().createCaller(ctxOf(OWNER_A, { kid: 'ifc_owner' })), 'merchantControl.limits.requestIncrease')(body(merchantB)),
    );
    expect(ownKey).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.interactive_required' });
    expect(foreignKey).toEqual(ownKey);
    const noMfa = await failure(
      at(
        mounted().createCaller(ctxOf(OWNER_A, { mfa: false })),
        'merchantControl.limits.withdraw',
      )({
        merchantId: merchantA,
        requestId: randomUUID(),
        reason: 'no session',
      }),
    );
    expect(noMfa).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.interactive_required' });
  });

  it('a suspended or closed merchant cannot file an ask, and can still withdraw one already filed', async () => {
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const requestId = randomUUID();
    await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId,
      caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '10' }],
      reason: 'TEST VALUE ask, not a cap',
    });
    await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${merchantA}`;
    const suspended = await failure(
      at(
        owner,
        'merchantControl.limits.requestIncrease',
      )({
        merchantId: merchantA,
        requestId: randomUUID(),
        caps: [{ kind: 'daily_payout', assetCode: 'USDT', limit: '1' }],
        reason: 'while suspended',
      }),
    );
    expect(suspended).toMatchObject({ code: 'PRECONDITION_FAILED', cause: 'pay.merchant_inactive' });
    const withdrawn = await at(
      owner,
      'merchantControl.limits.withdraw',
    )({
      merchantId: merchantA,
      requestId,
      reason: 'withdraw while suspended',
    });
    expect(withdrawn).toMatchObject({ status: 'withdrawn', requestId });
    await sql`UPDATE pay.merchants SET status = 'closed' WHERE id = ${merchantA}`;
    const closed = await failure(
      at(
        owner,
        'merchantControl.limits.requestIncrease',
      )({
        merchantId: merchantA,
        requestId: randomUUID(),
        caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '2' }],
        reason: 'while closed',
      }),
    );
    expect(closed).toMatchObject({ code: 'PRECONDITION_FAILED', cause: 'pay.merchant_inactive' });
    expect(await sql`SELECT 1 FROM pay.control_limit_requests WHERE merchant_id = ${merchantA} AND status = 'pending'`).toHaveLength(0);
  });

  it('withdraw and founder close each happen once, then a new ask can be filed', async () => {
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const founder = mounted().createCaller(ctxOf(FOUNDER_1));
    const first = randomUUID();
    await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId: first,
      caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '10' }],
      reason: 'TEST VALUE ask, not a cap',
    });
    const withdrawn = await at(
      owner,
      'merchantControl.limits.withdraw',
    )({
      merchantId: merchantA,
      requestId: first,
      reason: 'not needed',
    });
    expect(withdrawn).toMatchObject({ status: 'withdrawn', closedBy: OWNER_A });
    const replay = await at(
      owner,
      'merchantControl.limits.withdraw',
    )({
      merchantId: merchantA,
      requestId: first,
      reason: 'a different reason',
    });
    expect(replay).toMatchObject({ status: 'withdrawn', closeReason: 'not needed' });
    expect(await at(owner, 'merchantControl.limits.open')({ merchantId: merchantA })).toEqual({ status: 'none' });

    const second = randomUUID();
    await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId: second,
      caps: [{ kind: 'beneficiaries_per_day', limit: 4 }],
      reason: 'need a higher count',
    });
    const merchantClose = await failure(
      at(owner, 'founderAdmin.control.limitRequests.close')({ requestId: second, reason: 'merchant cannot' }),
    );
    expect(merchantClose?.code).toBe('FORBIDDEN');
    const closed = await at(founder, 'founderAdmin.control.limitRequests.close')({ requestId: second, reason: 'not this quarter' });
    expect(closed).toMatchObject({ status: 'closed', requestId: second, closeReason: 'not this quarter', closedBy: FOUNDER_1 });
    const closedAgain = await at(founder, 'founderAdmin.control.limitRequests.close')({ requestId: second, reason: 'again' });
    expect(closedAgain).toMatchObject({ closeReason: 'not this quarter' });
    const missing = await failure(
      at(founder, 'founderAdmin.control.limitRequests.close')({ requestId: randomUUID(), reason: 'no such ask' }),
    );
    expect(missing).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.limit_request_not_found' });
    expect(await at(founder, 'founderAdmin.control.limitRequests.list')({ limit: 10 })).toMatchObject({ requests: [], nextCursor: null });

    const third = randomUUID();
    const stored = await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId: third,
      caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '12' }],
      reason: 'asking again',
    });
    expect(stored).toMatchObject({ outcome: 'stored', requestId: third });
    const bad = await failure(
      at(
        owner,
        'merchantControl.limits.requestIncrease',
      )({
        merchantId: merchantA,
        requestId: randomUUID(),
        caps: [
          { kind: 'per_payment', assetCode: 'USDT', limit: '0' },
          { kind: 'per_payment', assetCode: 'USDT', limit: '3' },
        ],
        reason: 'zero and a duplicate',
      }),
    );
    expect(bad?.code).toBe('BAD_REQUEST');
  });

  it('confirming a cap change closes the pending ask in that transaction; a rejected or non-cap change does not', async () => {
    await assignTier();
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const requestId = randomUUID();
    await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId,
      caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '999' }],
      reason: 'TEST VALUE ask, not a cap',
    });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: merchantA,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: 'standard' },
    });
    expect(await sql`SELECT status FROM pay.control_limit_requests WHERE request_id = ${requestId}`).toEqual([{ status: 'pending' }]);

    const profile = (await at(owner, 'merchantControl.get')({ merchantId: merchantA })) as { version: string; caps: unknown };
    const capChange = {
      scope: 'merchant' as const,
      merchantId: merchantA,
      change: { kind: 'set_caps' as const, caps: [{ kind: 'per_payment' as const, assetCode: 'USDT', limit: '4' }] },
    };
    const rejectId = randomUUID();
    await changes.submit(FOUNDER_1, { requestId: rejectId, target: capChange, reason: 'try these caps', expectedVersion: profile.version });
    await changes.confirm(FOUNDER_2, {
      requestId: rejectId,
      decision: 'reject',
      reason: 'not these caps',
      expectedChangeHash: founderChangeHash(capChange, profile.version),
    });
    expect(await sql`SELECT status FROM pay.control_limit_requests WHERE request_id = ${requestId}`).toEqual([{ status: 'pending' }]);

    await applyChange(changes, sql, capChange);
    const [closed] = await sql<Array<{ status: string; close_reason: string; closed_by: string }>>`
      SELECT status, close_reason, closed_by FROM pay.control_limit_requests WHERE request_id = ${requestId}
    `;
    expect(closed).toEqual({ status: 'closed', close_reason: 'cap_change_confirmed', closed_by: FOUNDER_2 });
    expect(await at(owner, 'merchantControl.limits.open')({ merchantId: merchantA })).toEqual({ status: 'none' });
    const after = (await at(owner, 'merchantControl.get')({ merchantId: merchantA })) as { caps: Array<{ limit?: string }> | null };
    expect(after.caps?.some((cap) => cap.limit === '4')).toBe(true);
    expect(after.caps?.some((cap) => cap.limit === '999')).toBe(false);
  });

  it('a cap confirm that cannot close the pending ask leaves the caps unchanged', async () => {
    await assignTier();
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const requestId = randomUUID();
    await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId,
      caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '999' }],
      reason: 'TEST VALUE ask, not a cap',
    });
    const [before] = await sql<Array<{ caps_override: unknown; version: string }>>`
      SELECT caps_override, version::text AS version FROM pay.control_merchant_profiles WHERE merchant_id = ${merchantA}
    `;
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle', '0074_pay_limit_requests.sql'),
      'utf8',
    );
    try {
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION "pay"."control_limit_requests_close_once"() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'pay.control_limit_requests close refused';
        END
        $fn$
      `);
      await expect(
        applyChange(changes, sql, {
          scope: 'merchant',
          merchantId: merchantA,
          change: { kind: 'set_caps', caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '5' }] },
        }),
      ).rejects.toThrow(/close refused/);
      const [after] = await sql<Array<{ caps_override: unknown; version: string }>>`
        SELECT caps_override, version::text AS version FROM pay.control_merchant_profiles WHERE merchant_id = ${merchantA}
      `;
      expect(after).toEqual(before);
      expect(await sql`SELECT status FROM pay.control_limit_requests WHERE request_id = ${requestId}`).toEqual([{ status: 'pending' }]);
    } finally {
      await sql.unsafe(migration);
    }
  });

  it('the database keeps reason and requested_by bounded, and allows the pending move only once', async () => {
    const owner = mounted().createCaller(ctxOf(OWNER_A));
    const requestId = randomUUID();
    await at(
      owner,
      'merchantControl.limits.requestIncrease',
    )({
      merchantId: merchantA,
      requestId,
      caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '10' }],
      reason: 'TEST VALUE ask, not a cap',
    });
    await expect(sql`
      UPDATE pay.control_limit_requests
         SET status = 'closed', closed_at = now(), closed_by = ${FOUNDER_1}, close_reason = 'cap_change_confirmed', reason = 'rewritten'
       WHERE request_id = ${requestId}
    `).rejects.toThrow(/immutable/);
    await sql`
      UPDATE pay.control_limit_requests
         SET status = 'withdrawn', closed_at = now(), closed_by = ${OWNER_A}, close_reason = 'taken back'
       WHERE request_id = ${requestId}
    `;
    await expect(sql`
      UPDATE pay.control_limit_requests SET status = 'closed', closed_at = now(), closed_by = ${FOUNDER_1}, close_reason = 'too late'
       WHERE request_id = ${requestId}
    `).rejects.toThrow(/immutable/);
    const longReason = 'x'.repeat(501);
    await expect(sql`
      INSERT INTO pay.control_limit_requests (request_id, merchant_id, caps, reason, status, requested_by)
      VALUES (${randomUUID()}, ${merchantA}, ${sql.json([{ kind: 'per_payment', assetCode: 'USDT', limit: '1' }] as never)}, ${longReason}, 'pending', ${OWNER_A})
    `).rejects.toThrow(/control_limit_requests_reason_bounds/);
    await expect(sql`
      INSERT INTO pay.control_limit_requests (request_id, merchant_id, caps, reason, status, requested_by)
      VALUES (${randomUUID()}, ${merchantA}, ${sql.json([{ kind: 'per_payment', assetCode: 'USDT', limit: '1' }] as never)}, ${'ok reason'}, 'pending', ${'   '})
    `).rejects.toThrow(/control_limit_requests_requested_by_present/);
    await expect(sql`
      INSERT INTO pay.control_limit_requests (request_id, merchant_id, caps, reason, status, requested_by)
      VALUES (${randomUUID()}, ${merchantA}, ${sql.json([{ kind: 'per_payment', assetCode: 'USDT', limit: '1' }] as never)}, ${'ok reason'}, 'pending', ${null})
    `).rejects.toThrow(/null/);
  });

  it('the down migration removes the ask table and its close function', async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
    const down = readFileSync(join(dir, '0074_pay_limit_requests.down.sql'), 'utf8');
    const up = readFileSync(join(dir, '0074_pay_limit_requests.sql'), 'utf8');
    try {
      await sql.unsafe(down);
      const [rel] = await sql<Array<{ rel: string | null }>>`SELECT to_regclass('pay.control_limit_requests')::text AS rel`;
      expect(rel?.rel).toBeNull();
      expect(await sql`SELECT 1 FROM pg_proc WHERE proname = 'control_limit_requests_close_once'`).toHaveLength(0);
    } finally {
      await sql.unsafe(up);
    }
  });
});
