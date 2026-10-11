import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { SESSION_SCOPES } from '@intafaced/auth';
import {
  encodePrincipal,
  signPrincipalHeader,
  type Context,
  type IdentityOperationDecisionPort,
  type IdentityOperationIntent,
} from '@intafaced/contracts';
import { PayService } from './payment-service.js';
import { SubMerchantService } from './submerchants.js';
import { createPayRouter } from './router.js';
import type { UserMoneyService } from './user-money-service.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { memoryPayoutDestinations } from './merchant-payout-destination.js';
import { createPayfacAuthorityGuard, drainPayfacPermissionIntents } from './payfac-authority.js';
import { registerPublicPayRest } from './public-rest.js';
const dir = new URL('../drizzle/', import.meta.url);
const migrations = readdirSync(dir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, dir), 'utf8'));
describe('PayFac original credential admission real PostgreSQL', () => {
  let db: TestDatabase, trees: SubMerchantService, pay: PayService;
  let ledger: MemoryLedger;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'pay', migrations });
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE pay.merchants CASCADE`;
    trees = new SubMerchantService(db.sql);
    ledger = new MemoryLedger();
  });
  async function node(parentId?: string) {
    const id = randomUUID(),
      userId = randomUUID();
    await db.sql`INSERT INTO pay.merchants(id,user_id,parent_merchant_id,status,pricing) VALUES(${id},${userId},${parentId ?? null},'active','{"feeBps":0}')`;
    return { id, userId };
  }
  function caller(userId: string, identity: IdentityOperationDecisionPort, apiKeyId?: string) {
    const rails = new RailRegistry([
      new CardSandboxAdapter({ secret: 'payfac-sandbox-secret-at-least-32-characters', toleranceSeconds: 300 }),
    ]);
    const destinations = memoryPayoutDestinations();
    pay = new PayService(db.sql, ledger, rails, {
      identityOperationAdmission: identity,
      identityAuthorityGuard: createPayfacAuthorityGuard(trees),
      payoutDestinations: destinations,
    });
    const ctx: Context = {
      principal: {
        userId,
        sub: userId,
        sid: randomUUID(),
        ...(apiKeyId ? { kid: apiKeyId } : {}),
        scopes: [...SESSION_SCOPES, 'pay:read', 'pay:write', 'pay:payout'],
        mfa: !apiKeyId,
        tier: 'full',
        expiresAt: new Date(Date.now() + 60000),
      },
      service: null,
      region: 'DE',
      requestId: randomUUID(),
    };
    return createPayRouter(pay, rails, {} as UserMoneyService, trees, destinations).createCaller(ctx);
  }
  it.each([
    ['root', false],
    ['root', true],
    ['event', false],
    ['event', true],
  ] as const)('preserves legitimate %s authority over a child, API key=%s', async (proof, apiKey) => {
    const root = await node(),
      middle = await node(root.id),
      child = await node(middle.id);
    const actor = proof === 'root' ? root : middle;
    if (proof === 'event')
      await trees.grantPermission({
        actorMerchantId: root.id,
        granteeMerchantId: middle.id,
        subjectMerchantId: child.id,
        area: 'payment',
        reason: 'Operate child payments',
        actorId: root.userId,
        actorScope: 'pay:write',
      });
    if (proof === 'event')
      await trees.grantPermission({
        actorMerchantId: root.id,
        granteeMerchantId: middle.id,
        subjectMerchantId: child.id,
        area: 'settlement.payout',
        reason: 'Operate child payouts',
        actorId: root.userId,
        actorScope: 'pay:write',
      });
    const kinds: string[] = [];
    const keyId = apiKey ? randomUUID() : undefined;
    const api = caller(
      actor.userId,
      {
        decide: async ({ intent }) => {
          kinds.push(intent.operation.kind);
          expect(intent.operation.userId).toBe(child.userId);
          expect(intent.authority).toMatchObject({
            kind: 'payfac_credential',
            subject: { userId: actor.userId, credential: apiKey ? { kind: 'api_key', apiKeyId: keyId } : { kind: 'session' } },
            proof: { kind: proof === 'root' ? 'root_relation' : 'explicit_grant', actorMerchantId: actor.id, subjectMerchantId: child.id },
          });
          return {
            status: 'granted',
            intent,
            grantId: randomUUID(),
            identityVersion: '0',
            decidedAt: new Date().toISOString(),
          };
        },
      },
      keyId,
    );
    const payment = await api.payment.create({
      requestId: randomUUID(),
      merchantId: child.id,
      amount: '8',
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    expect(payment.merchantId).toBe(child.id);
    expect((await api.payment.authorize({ paymentId: payment.id })).status).toBe('authorized');
    expect((await api.payment.capture({ paymentId: payment.id })).status).toBe('captured');
    const settlement = await pay.settleWindow({
      merchantId: child.id,
      window: 'payfac-four-doors',
      assetId: 'USDT',
      from: new Date(0),
      to: new Date(Date.now() + 60000),
    });
    const payout = {
      settlementId: settlement.id,
      railId: 'card-sandbox',
      destination: { kind: 'bank', ref: 'DE89370400440532013000' },
    };
    if (apiKey) {
      // Existing pay:payout guard requires MFA; ordinary API keys carry no MFA.
      await expect(api.settlement.payout(payout)).rejects.toMatchObject({
        message: 'Scope "pay:payout" requires two-factor authentication',
      });
      expect(kinds).toEqual(['payment.create', 'payment.authorize', 'payment.capture']);
    } else {
      expect((await api.settlement.payout(payout)).status).toBe('paid_out');
      expect(kinds).toEqual(['payment.create', 'payment.authorize', 'payment.capture', 'payout']);
    }
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
  async function delegation() {
    const root = await node(),
      middle = await node(root.id),
      child = await node(middle.id);
    const input = {
      actorMerchantId: root.id,
      granteeMerchantId: middle.id,
      subjectMerchantId: child.id,
      area: 'payment',
      reason: 'Operate child payments',
      actorId: root.userId,
      actorScope: 'pay:write',
    };
    const grant = await trees.grantPermission(input);
    return { root, middle, child, input, grant };
  }
  it('signed merchant REST preserves an explicitly delegated API key on create, authorize and capture', async () => {
    const d = await delegation();
    const keyId = randomUUID(),
      kinds: string[] = [];
    caller(
      d.middle.userId,
      {
        decide: async ({ intent }) => {
          kinds.push(intent.operation.kind);
          expect(intent.authority).toMatchObject({
            kind: 'payfac_credential',
            subject: { userId: d.middle.userId, credential: { kind: 'api_key', apiKeyId: keyId } },
            proof: { kind: 'explicit_grant', grantEventId: d.grant.id, grantSequence: d.grant.seq },
          });
          return { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() };
        },
      },
      keyId,
    );
    const app = Fastify({ logger: false }),
      secret = 'payfac-rest-edge-secret-at-least-32-characters';
    await registerPublicPayRest(app, { pay, trees, serviceName: 'svc-pay', edgeSecret: secret });
    const raw = encodePrincipal({
      userId: d.middle.userId,
      sub: d.middle.userId,
      sid: randomUUID(),
      kid: keyId,
      key_env: 'sandbox',
      scopes: ['pay:read', 'pay:write'],
      tier: 'full',
      mfa: false,
      expiresAt: new Date(Date.now() + 60000),
    });
    const headers = {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, secret, 'DE'),
      'x-intafaced-region': 'DE',
      'content-type': 'application/json',
    };
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/payments',
        headers: { ...headers, 'idempotency-key': 'delegated-create' },
        payload: {
          merchantId: d.child.id,
          amount: '8',
          assetId: 'USDT',
          method: 'card',
          railAdapter: 'card-sandbox',
          instrument: { kind: 'card', token: 'tok_ok' },
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().id;
      for (const action of ['authorize', 'capture']) {
        const result = await app.inject({
          method: 'POST',
          url: `/v1/payments/${id}/${action}`,
          headers: { ...headers, 'idempotency-key': `delegated-${action}` },
          payload: {},
        });
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json().status).toBe(action === 'authorize' ? 'authorized' : 'captured');
      }
      expect(kinds).toEqual(['payment.create', 'payment.authorize', 'payment.capture']);
      expect(ledger.reconcile()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
  it('permission cutoff waits for the actual in-flight grant guard before cancelling a lost acknowledgement', async () => {
    const d = await delegation();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let grants = 0;
    const identity: IdentityOperationDecisionPort = {
      decide: async ({ mode, intent }) => {
        if (mode === 'grant') {
          grants++;
          enter();
          await barrier;
          return { status: 'unavailable', code: 'authority.unavailable' };
        }
        return { status: 'cancelled', intent, code: 'admission.cancelled', decidedAt: new Date().toISOString() };
      },
    };
    const api = caller(d.middle.userId, identity);
    const request = {
      requestId: randomUUID(),
      merchantId: d.child.id,
      amount: '8',
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    };
    const creation = expect(api.payment.create(request)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await entered;
    const writer = new SubMerchantService(db.sql, (tx, current) => drainPayfacPermissionIntents(tx, current, identity));
    const revocation = writer.revokePermission({ ...d.input, reason: 'Cut off in-flight delegated permission' });
    try {
      let blocked = false;
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const [row] =
          await db.sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'`;
        if (Number(row?.count ?? 0) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(await trees.holds(d.middle.id, d.child.id, 'payment')).toBe(true);
    } finally {
      release();
    }
    await creation;
    expect((await revocation).action).toBe('revoke');
    await expect(pay.createPayment({ ...request, amount: parseAmount('8') })).rejects.toMatchObject({
      code: 'pay.identity_admission_denied',
    });
    expect(grants).toBe(1);
    expect(await db.sql`SELECT id FROM pay.payments`).toHaveLength(0);
    expect(await db.sql`SELECT kind FROM pay.payment_admission_outcomes WHERE kind='identity_cancelled'`).toHaveLength(1);
  });
  it.each(['cancelled', 'granted'] as const)(
    'payout permission cutoff resolves an original marked payout as %s before recovery',
    async (outcome) => {
      const d = await delegation();
      const payoutPermission = { ...d.input, area: 'settlement.payout', reason: 'Operate child payouts' };
      await trees.grantPermission(payoutPermission);
      let payoutGrants = 0;
      const identity: IdentityOperationDecisionPort = {
        decide: async ({ mode, intent }) => {
          if (intent.operation.kind === 'payout') {
            if (mode === 'grant') {
              payoutGrants++;
              return { status: 'unavailable', code: 'authority.unavailable' };
            }
            return outcome === 'cancelled'
              ? { status: 'cancelled', intent, code: 'admission.cancelled', decidedAt: new Date().toISOString() }
              : { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() };
          }
          return { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() };
        },
      };
      const api = caller(d.middle.userId, identity);
      const payment = await api.payment.create({
        requestId: randomUUID(),
        merchantId: d.child.id,
        amount: '8',
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      await api.payment.authorize({ paymentId: payment.id });
      await api.payment.capture({ paymentId: payment.id });
      const settlement = await pay.settleWindow({
        merchantId: d.child.id,
        window: 'pending-payfac-payout',
        assetId: 'USDT',
        from: new Date(0),
        to: new Date(Date.now() + 60000),
      });
      const request = {
        settlementId: settlement.id,
        railId: 'card-sandbox',
        destination: { kind: 'bank' as const, ref: 'DE89370400440532013000' },
      };
      await expect(api.settlement.payout(request)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(trees.revokePermission({ ...payoutPermission, reason: 'Cut off child payouts' })).rejects.toMatchObject({
        code: 'pay.identity_admission_unavailable',
      });
      const writer = new SubMerchantService(db.sql, (tx, current) => drainPayfacPermissionIntents(tx, current, identity));
      await writer.revokePermission({ ...payoutPermission, reason: 'Cut off child payouts' });
      await expect(api.settlement.payout(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      if (outcome === 'cancelled') {
        await expect(pay.payoutSettlement(request)).rejects.toMatchObject({ code: 'pay.identity_admission_denied' });
        expect(await db.sql`SELECT kind FROM pay.payout_outcomes WHERE kind='identity_cancelled'`).toHaveLength(1);
        expect(await db.sql`SELECT kind FROM pay.payout_outcomes WHERE kind IN('rail_accepted','settled')`).toHaveLength(0);
      } else {
        await expect(
          pay.payoutSettlement({ ...request, destination: { kind: 'bank', ref: 'GB82WEST12345698765432' } }),
        ).rejects.toMatchObject({ code: 'pay.payout_recovery_conflict' });
        expect((await pay.payoutSettlement(request)).status).toBe('paid_out');
        expect((await pay.payoutSettlement(request)).status).toBe('paid_out');
        expect(await db.sql`SELECT kind FROM pay.payout_outcomes WHERE kind='identity_granted'`).toHaveLength(1);
        expect(await db.sql`SELECT kind FROM pay.payout_outcomes WHERE kind='rail_accepted'`).toHaveLength(1);
        expect(await db.sql`SELECT kind FROM pay.payout_outcomes WHERE kind='settled'`).toHaveLength(1);
      }
      expect(payoutGrants).toBe(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    },
  );
  it('permission revocation refuses missing or failed pending drain, then cancels original tickets before cutoff', async () => {
    const d = await delegation();
    let grants = 0;
    const identity: IdentityOperationDecisionPort = {
      decide: async ({ mode, intent }) => {
        if (mode === 'grant') {
          grants++;
          return { status: 'unavailable', code: 'authority.unavailable' };
        }
        return { status: 'cancelled', intent, code: 'admission.cancelled', decidedAt: new Date().toISOString() };
      },
    };
    const api = caller(d.middle.userId, identity),
      requestId = randomUUID();
    await expect(
      api.payment.create({
        requestId,
        merchantId: d.child.id,
        amount: '8',
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(trees.revokePermission({ ...d.input, reason: 'Revoke child money permission' })).rejects.toMatchObject({
      code: 'pay.identity_admission_unavailable',
    });
    expect(await trees.holds(d.middle.id, d.child.id, 'payment')).toBe(true);
    const failed = new SubMerchantService(db.sql, async () => {
      throw new Error('test.network_unavailable');
    });
    await expect(failed.revokePermission({ ...d.input, reason: 'Revoke child money permission' })).rejects.toMatchObject({
      code: 'pay.identity_admission_unavailable',
    });
    const incomplete = new SubMerchantService(db.sql, async () => undefined);
    await expect(incomplete.revokePermission({ ...d.input, reason: 'Revoke child money permission' })).rejects.toMatchObject({
      code: 'pay.identity_admission_unavailable',
    });
    const writer = new SubMerchantService(db.sql, (tx, current) => drainPayfacPermissionIntents(tx, current, identity));
    expect((await writer.revokePermission({ ...d.input, reason: 'Revoke child money permission' })).action).toBe('revoke');
    expect(await trees.holds(d.middle.id, d.child.id, 'payment')).toBe(false);
    await expect(
      pay.createPayment({
        requestId,
        merchantId: d.child.id,
        amount: parseAmount('8'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      }),
    ).rejects.toMatchObject({ code: 'pay.identity_admission_denied' });
    expect(grants).toBe(1);
    expect(await db.sql`SELECT id FROM pay.payments`).toHaveLength(0);
    expect(await db.sql`SELECT kind FROM pay.payment_admission_outcomes WHERE kind='identity_cancelled'`).toHaveLength(1);
  });
  it('lost grant acknowledgement resolves before revoke and recovers only the original admitted work', async () => {
    const d = await delegation();
    let issued: IdentityOperationIntent | undefined;
    let grants = 0;
    const grantId = randomUUID();
    const identity: IdentityOperationDecisionPort = {
      decide: async ({ mode, intent }) => {
        if (mode === 'grant') {
          issued = intent;
          grants++;
          return { status: 'unavailable', code: 'authority.unavailable' };
        }
        return { status: 'granted', intent: issued ?? intent, grantId, identityVersion: '0', decidedAt: new Date().toISOString() };
      },
    };
    const api = caller(d.middle.userId, identity),
      requestId = randomUUID();
    const request = {
      requestId,
      merchantId: d.child.id,
      amount: '8',
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    };
    await expect(api.payment.create(request)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const writer = new SubMerchantService(db.sql, (tx, current) => drainPayfacPermissionIntents(tx, current, identity));
    await writer.revokePermission({ ...d.input, reason: 'Cut off delegated money permission' });
    await expect(api.payment.create(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const recovered = await pay.createPayment({ ...request, amount: parseAmount(request.amount) });
    expect(recovered.id).toBe(requestId);
    expect(grants).toBe(1);
    await expect(pay.createPayment({ ...request, amount: parseAmount('9') })).rejects.toMatchObject({
      code: 'pay.identity_admission_conflict',
    });
    await expect(
      pay.createPayment({ ...request, requestId: randomUUID(), amount: parseAmount('8'), identityAuthority: issued!.authority }),
    ).rejects.toMatchObject({ code: 'pay.identity_admission_denied' });
  });
});
