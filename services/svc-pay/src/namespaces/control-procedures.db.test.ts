import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import type { Context } from '@intafaced/contracts';
import { PayService } from '../payment-service.js';
import { MerchantControlError } from '../merchant-account-controls.js';
import { RailRegistry } from '../rails/registry.js';
import { ChangeService } from '../control/changes.js';
import { ControlService } from '../control/service.js';
import { ownerAccessPorts } from '../control/access.js';
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
import { createPayNamespaces, FOUNDER_ONLY_PREFIXES, findUnguardedFounderProcedures } from './index.js';

/**
 * The control-room procedures on the wire: merchant isolation (M1/M4), founder
 * only (G1, G3, G7) and the end-to-end change flow with two founder sessions.
 */
describe('control-room procedures', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let changes!: ChangeService;
  let merchantA = '';
  let merchantB = '';
  const FOUNDERS = new Set([FOUNDER_1, FOUNDER_2]);

  const founderAuthority = async (ctx: Context): Promise<string> => {
    const p = ctx.principal;
    if (ctx.service || !p || !p.mfa || (p as { kid?: string }).kid || !FOUNDERS.has(p.userId))
      throw new MerchantControlError('operator.denied');
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
  const caller = (userId: string | null, over: Record<string, unknown> = {}) => {
    const control = new ControlService(sql, ownerAccessPorts(sql));
    return createPayNamespaces({ founderAuthority, control }).createCaller(ctxOf(userId, over));
  };
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
    changes = new ChangeService(sql);
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    const pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    merchantA = (await pay.createMerchant({ userId: OWNER_A, pricing: { feeBps: 0 } })).id;
    merchantB = (await pay.createMerchant({ userId: OWNER_B, pricing: { feeBps: 0 } })).id;
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: merchantA,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('G7: every procedure under founderAdmin.* (including founderAdmin.control.*) sits behind founder authority', () => {
    const router = createPayNamespaces({ founderAuthority, control: new ControlService(sql, ownerAccessPorts(sql)) });
    expect(findUnguardedFounderProcedures(router, FOUNDER_ONLY_PREFIXES)).toEqual([]);
    const paths = Object.keys((router as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);
    expect(paths.filter((p) => p.startsWith('founderAdmin.control.')).length).toBe(10);
  });

  describe('M1: merchant A cannot reach merchant B through any merchantControl procedure', () => {
    const missing = randomUUID();
    const calls = (target: string): Record<string, unknown> => ({
      'merchantControl.get': { merchantId: target },
      'merchantControl.usage': { merchantId: target },
      'merchantControl.pricing.preview': { merchantId: target, assetCode: 'USDT', amount: '10' },
      'merchantControl.approvals.list': { merchantId: target, limit: 10 },
      'merchantControl.approvals.request': { merchantId: target, settlementId: randomUUID(), railId: 'crypto-native' },
      'merchantControl.tiers.list': { merchantId: target },
      'merchantControl.pricing.history': { merchantId: target, limit: 10 },
      'merchantControl.limits.open': { merchantId: target },
      'merchantControl.limits.requestIncrease': {
        merchantId: target,
        requestId: randomUUID(),
        caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '1' }],
        reason: 'isolation probe',
      },
      'merchantControl.limits.withdraw': {
        merchantId: target,
        requestId: randomUUID(),
        reason: 'isolation probe',
      },
    });
    for (const path of Object.keys(calls(missing))) {
      it(`${path}: B's id and a non-existent id get the identical refusal`, async () => {
        const a = caller(OWNER_A);
        const forB = await failure(at(a, path)(calls(merchantB)[path]));
        const forMissing = await failure(at(a, path)(calls(missing)[path]));
        expect(forB).not.toBeNull();
        expect(forB).toEqual(forMissing);
        expect(forB!.code).toBe('NOT_FOUND');
        expect(forB!.cause).toBe('pay.merchant_not_found');
      });
    }

    it("A reads A; and B, who has no tier, sees null sections rather than A's data", async () => {
      const own = (await at(caller(OWNER_A), 'merchantControl.get')({ merchantId: merchantA })) as { tierId: string; caps: unknown[] };
      expect(own.tierId).toBe(TEST_TIER.id);
      expect(own.caps.length).toBeGreaterThan(0);
      const b = (await at(caller(OWNER_B), 'merchantControl.get')({ merchantId: merchantB })) as {
        tierId: string | null;
        caps: unknown;
        pricing: unknown;
      };
      expect(b).toMatchObject({ tierId: null, caps: null });
    });

    it("M4: another merchant cannot decide A's approval, and gets the not-found answer", async () => {
      const real = await failure(
        at(
          caller(OWNER_B),
          'merchantControl.approvals.decide',
        )({ approvalId: randomUUID(), decision: 'approve', expectedPayloadHash: `sha256:${'a'.repeat(64)}`, reason: 'looks fine' }),
      );
      expect(real).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.approval_not_found' });
    });

    it('a team checker deciding holds pay:onboard, not pay:write: the scope guard lets it through to the role check', async () => {
      // The owner grant law gives pay:write to the owner alone; admin and finance carry pay:onboard and hold
      // payout.approve in the role table, so the decision is the role check's, not the scope's.
      const decide = (scopes: string[]) =>
        failure(
          at(
            caller(OWNER_B, { scopes }),
            'merchantControl.approvals.decide',
          )({ approvalId: randomUUID(), decision: 'approve', expectedPayloadHash: `sha256:${'a'.repeat(64)}`, reason: 'looks fine' }),
        );
      expect(await decide(['pay:onboard'])).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.approval_not_found' });
      expect((await decide(['pay:read']))!.code).toBe('FORBIDDEN');
    });

    it('an anonymous caller and a caller without the scope are refused before any data', async () => {
      expect((await failure(at(caller(null), 'merchantControl.get')({ merchantId: merchantA })))!.code).toBe('UNAUTHORIZED');
      const noScope = await failure(
        at(
          caller(OWNER_A, { scopes: ['pay:read'] }),
          'merchantControl.approvals.request',
        )({ merchantId: merchantA, settlementId: randomUUID(), railId: 'x' }),
      );
      expect(noScope!.code).toBe('FORBIDDEN');
    });
  });

  describe('G1/G3: founder procedures refuse everyone who is not a live founder', () => {
    const founderCalls: Record<string, unknown> = {
      'founderAdmin.control.tiers.list': {},
      'founderAdmin.control.pricing.rules': {},
      'founderAdmin.control.merchant.get': { merchantId: randomUUID() },
      'founderAdmin.control.merchant.usage': { merchantId: randomUUID() },
      'founderAdmin.control.configure.submit': {
        requestId: randomUUID(),
        change: { kind: 'upsert_tier', tier: TEST_TIER },
        reason: 'try it',
        expectedVersion: '0',
      },
      'founderAdmin.control.configure.confirm': {
        requestId: randomUUID(),
        decision: 'confirm',
        reason: 'confirm it',
        expectedChangeHash: `sha256:${'a'.repeat(64)}`,
      },
      'founderAdmin.control.approvals.decide': {
        approvalId: randomUUID(),
        decision: 'approve',
        expectedPayloadHash: `sha256:${'a'.repeat(64)}`,
        reason: 'yes please',
      },
      'founderAdmin.changes.submit': {
        requestId: randomUUID(),
        merchantId: randomUUID(),
        change: { kind: 'set_tier', tierId: 'x1', archetypeId: null },
        reason: 'try it',
        expectedVersion: '0',
      },
      'founderAdmin.changes.confirm': {
        requestId: randomUUID(),
        decision: 'confirm',
        reason: 'confirm it',
        expectedChangeHash: `sha256:${'a'.repeat(64)}`,
      },
      'founderAdmin.approvals.list': { limit: 10 },
      'founderAdmin.control.limitRequests.list': { limit: 10 },
      'founderAdmin.control.limitRequests.close': { requestId: randomUUID(), reason: 'not yours' },
      'founderAdmin.approvals.destination': { approvalId: randomUUID() },
      'founderAdmin.changes.pending': { limit: 10 },
      'founderAdmin.control.audit.list': { limit: 10 },
    };
    for (const [path, input] of Object.entries(founderCalls)) {
      it(`${path}: a merchant session with every pay scope is refused; so is an API key and a founder without MFA`, async () => {
        for (const c of [caller(OWNER_A), caller(FOUNDER_1, { kid: 'ifc_key' }), caller(FOUNDER_1, { mfa: false }), caller(null)]) {
          const err = await failure(at(c, path)(input));
          expect(err).not.toBeNull();
          expect(['FORBIDDEN', 'UNAUTHORIZED']).toContain(err!.code);
        }
      });
    }
  });

  it('end to end: founder 1 submits a tier and a merchant tier change, founder 2 confirms, the merchant sees it, usage and preview work', async () => {
    const f1 = caller(FOUNDER_1);
    const f2 = caller(FOUNDER_2);
    const tier = { ...TEST_TIER, id: 'second-tier', name: 'TEST VALUE second' };
    const requestId = randomUUID();
    const tierHash = founderChangeHash({ scope: 'tier', change: { kind: 'upsert_tier', tier } }, '0');
    const submitted = (await at(
      f1,
      'founderAdmin.control.configure.submit',
    )({ requestId, change: { kind: 'upsert_tier', tier }, reason: 'add a tier', expectedVersion: '0' })) as {
      outcome: string;
      actorUserId: string;
    };
    expect(submitted).toMatchObject({ outcome: 'pending_second_approval', actorUserId: FOUNDER_1 });
    expect(
      await failure(
        at(f1, 'founderAdmin.control.configure.confirm')({ requestId, decision: 'confirm', reason: 'self', expectedChangeHash: tierHash }),
      ),
    ).toMatchObject({ code: 'PRECONDITION_FAILED', cause: 'pay.dual_control_required' });
    expect(
      await at(
        f2,
        'founderAdmin.control.configure.confirm',
      )({ requestId, decision: 'confirm', reason: 'agreed', expectedChangeHash: tierHash }),
    ).toMatchObject({
      outcome: 'changed',
      scope: 'tier',
      version: '1',
    });
    const tiers = (await at(f1, 'founderAdmin.control.tiers.list')({})) as Array<{ id: string; merchants: number }>;
    expect(tiers.map((t) => t.id).sort()).toEqual(['second-tier', TEST_TIER.id]);
    expect(tiers.find((t) => t.id === TEST_TIER.id)!.merchants).toBe(1);

    const changeId = randomUUID();
    const sub = (await at(
      f1,
      'founderAdmin.changes.submit',
    )({
      requestId: changeId,
      merchantId: merchantB,
      change: { kind: 'set_tier', tierId: 'second-tier', archetypeId: 'standard' },
      reason: 'onboard B',
      expectedVersion: '0',
    })) as { outcome: string; profile: { tierId: string | null } };
    expect(sub.outcome).toBe('pending_second_approval');
    expect(sub.profile.tierId).toBeNull();
    const changeHash = founderChangeHash(
      { scope: 'merchant', merchantId: merchantB, change: { kind: 'set_tier', tierId: 'second-tier', archetypeId: 'standard' } },
      '0',
    );
    // The same change shown for a different merchant is not this change: refused through the router, nothing applied.
    expect(
      await failure(
        at(
          f2,
          'founderAdmin.changes.confirm',
        )({
          requestId: changeId,
          decision: 'confirm',
          reason: 'wrong merchant',
          expectedChangeHash: founderChangeHash(
            { scope: 'merchant', merchantId: merchantA, change: { kind: 'set_tier', tierId: 'second-tier', archetypeId: 'standard' } },
            '0',
          ),
        }),
      ),
    ).toMatchObject({ code: 'CONFLICT', cause: 'pay.change_hash_mismatch' });
    // A confirm with no hash at all is not a valid request.
    expect(
      await failure(at(f2, 'founderAdmin.changes.confirm')({ requestId: changeId, decision: 'confirm', reason: 'no hash' })),
    ).not.toBeNull();
    const done = (await at(
      f2,
      'founderAdmin.changes.confirm',
    )({ requestId: changeId, decision: 'confirm', reason: 'agreed', expectedChangeHash: changeHash })) as {
      outcome: string;
      profile: { tierId: string; archetypeId: string };
    };
    expect(done).toMatchObject({ outcome: 'changed', profile: { tierId: 'second-tier', archetypeId: 'standard' } });
    // A tier change confirmed through the merchant-shaped procedure is not offered.
    expect(
      await failure(
        at(f2, 'founderAdmin.changes.confirm')({ requestId, decision: 'confirm', reason: 'wrong door', expectedChangeHash: tierHash }),
      ),
    ).toMatchObject({
      cause: 'pay.change_not_found',
    });

    const b = caller(OWNER_B);
    expect(await at(b, 'merchantControl.get')({ merchantId: merchantB })).toMatchObject({ tierId: 'second-tier' });
    const usage = (await at(b, 'merchantControl.usage')({ merchantId: merchantB })) as {
      rows: Array<{ kind: string; used: string | null; remaining: string | null }>;
    };
    expect(usage.rows.find((r) => r.kind === 'daily_intake')).toMatchObject({ used: '0', remaining: '300' });
    expect(
      await at(b, 'merchantControl.pricing.preview')({ merchantId: merchantB, assetCode: 'USDT', amount: '100', conversion: true }),
    ).toMatchObject({ fee: '2.8', spread: '0.4', net: '96.8' });
    const rules = (await at(f1, 'founderAdmin.control.pricing.rules')({ layer: 'global' })) as Array<{ ruleId: string; assetCode: string }>;
    expect(rules).toHaveLength(1);
    void amt;
  });

  it('works whichever PAY_MERCHANT_CONTROLS says: the procedures never read the switch', async () => {
    const before = process.env.PAY_MERCHANT_CONTROLS;
    for (const mode of ['off', 'required']) {
      process.env.PAY_MERCHANT_CONTROLS = mode;
      expect(await at(caller(OWNER_A), 'merchantControl.get')({ merchantId: merchantA })).toMatchObject({ tierId: TEST_TIER.id });
    }
    if (before === undefined) delete process.env.PAY_MERCHANT_CONTROLS;
    else process.env.PAY_MERCHANT_CONTROLS = before;
  });
});
