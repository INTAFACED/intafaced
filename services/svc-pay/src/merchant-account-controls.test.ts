import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { accountControlResultSchema, type AccountControlInput, type Context } from '@intafaced/contracts';
import { MerchantAccountControls, MerchantControlError } from './merchant-account-controls.js';
import { withPayoutLock, insertPayoutAdmission, finalizePayoutIdentity, drainPendingPayoutIdentityIntents } from './payout-admission.js';
import type { IdentityOperationDecisionPort } from '@intafaced/contracts';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { createMerchantStateRouter } from './merchant-state-router.js';
import type { MerchantStateService } from './merchant-state-service.js';
const founders: [string, string] = [randomUUID(), randomUUID()];
function context(userId: string = founders[0]!, scopes: string[] = [...SESSION_SCOPES]): Context {
  return {
    principal: { userId, sub: userId, sid: randomUUID(), scopes, mfa: true, tier: 'full', expiresAt: new Date(Date.now() + 60000) },
    service: null,
    region: 'ID',
    requestId: randomUUID(),
  };
}
const migrationDir = new URL('../drizzle/', import.meta.url);
const migrations = readdirSync(migrationDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, migrationDir), 'utf8'));
describe('merchant founder controls real PostgreSQL', () => {
  let db: TestDatabase;
  let controls: MerchantAccountControls;
  let enabled: boolean;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'pay', migrations });
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE pay.account_control_audit,pay.account_control_requests,pay.merchants CASCADE`;
    enabled = true;
    controls = new MerchantAccountControls(db.sql, async (ctx) => {
      if (!enabled || !ctx.principal || !founders.includes(ctx.principal.userId)) throw new MerchantControlError('operator.denied');
      return ctx.principal.userId;
    });
  });
  afterAll(async () => {
    await db.drop();
  });
  async function merchant(status = 'active') {
    const id = randomUUID();
    await db.sql`INSERT INTO pay.merchants(id,user_id,status) VALUES(${id},${randomUUID()},${status}::pay.merchant_status)`;
    return id;
  }
  function command(merchantId: string, action: 'restrict' | 'restore' = 'restrict', expectedVersion = '0'): AccountControlInput {
    return {
      requestId: randomUUID(),
      target: { area: 'merchant', merchantId },
      action,
      reason: 'Founder reviewed account policy',
      expectedVersion,
    };
  }
  it('ordinary interactive login scopes let an entitled MFA founder use new and legacy routes', async () => {
    const config = {
      secret: 'merchant-control-test-secret-at-least-32-characters',
      issuer: 'intafaced',
      audience: 'intafaced.api',
      accessTtlSeconds: 900,
    };
    const issued = await issueAccessToken(
      { userId: founders[0], sessionId: randomUUID(), scopes: SESSION_SCOPES, mfa: true, tier: 'full' },
      config,
    );
    const principal = await verifyAccessToken(issued.token, config);
    expect(principal.scopes.some((scope) => scope.startsWith('admin:'))).toBe(false);
    const caller = createMerchantStateRouter({} as MerchantStateService, controls).createCaller({ ...context(), principal });
    const id = await merchant();
    expect((await caller.accountControls.change(command(id))).outcome).toBe('changed');
    expect(await caller.accountControls.getState({ target: { area: 'merchant', merchantId: id } })).toMatchObject({
      restricted: true,
      version: '1',
    });
    expect((await caller.merchantState.set(command(id, 'restore', '1'))).outcome).toBe('changed');
    expect(await caller.accountControls.history({ target: { area: 'merchant', merchantId: id }, limit: 10 })).toHaveLength(2);
    expect(await caller.merchantState.history({ target: { area: 'merchant', merchantId: id }, limit: 10 })).toHaveLength(2);
    expect(await db.sql`SELECT actor_scope FROM pay.merchant_status_events WHERE merchant_id=${id}`).toEqual([
      { actor_scope: 'identity.operator_entitlement' },
      { actor_scope: 'identity.operator_entitlement' },
    ]);
  });
  it('new and legacy routes refuse signed non-founders, API keys, subaccounts and service contexts', async () => {
    const config = {
      secret: 'merchant-control-test-secret-at-least-32-characters',
      issuer: 'intafaced',
      audience: 'intafaced.api',
      accessTtlSeconds: 900,
    };
    const signed = async (userId: string, extra: { apiKeyId?: string; subAccountId?: string } = {}) =>
      verifyAccessToken(
        (await issueAccessToken({ userId, sessionId: randomUUID(), scopes: SESSION_SCOPES, mfa: true, tier: 'full', ...extra }, config))
          .token,
        config,
      );
    const id = await merchant();
    const founder = await signed(founders[0]);
    for (const rejected of [
      { ...context(), principal: await signed(randomUUID()) },
      { ...context(), principal: await signed(founders[0], { apiKeyId: randomUUID() }) },
      { ...context(), principal: await signed(founders[0], { subAccountId: randomUUID() }) },
      { ...context(), principal: founder, service: 'svc-admin' },
    ]) {
      const caller = createMerchantStateRouter({} as MerchantStateService, controls).createCaller(rejected);
      expect(await caller.accountControls.change(command(id))).toMatchObject({
        outcome: 'refused',
        code: 'operator.denied',
        current: null,
      });
      expect(await caller.merchantState.set(command(id))).toMatchObject({ outcome: 'refused', code: 'operator.denied', current: null });
      await expect(caller.accountControls.getState({ target: { area: 'merchant', merchantId: id } })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(caller.merchantState.history({ target: { area: 'merchant', merchantId: id }, limit: 10 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    const service = createMerchantStateRouter({} as MerchantStateService, controls).createCaller({
      ...context(),
      principal: null,
      service: 'svc-admin',
    });
    await expect(service.accountControls.change(command(id))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(service.merchantState.set(command(id))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await controls.getState(context(), { target: { area: 'merchant', merchantId: id } })).toMatchObject({
      restricted: false,
      version: '0',
    });
  });
  it('either founder independently restricts/restores with actual actor and immutable history', async () => {
    const id = await merchant();
    const a = await controls.change(context(founders[0]), command(id));
    expect(a.outcome).toBe('changed');
    const b = await controls.change(context(founders[1]), command(id, 'restore', '1'));
    expect(b.outcome).toBe('changed');
    const history = await controls.history(context(), { target: { area: 'merchant', merchantId: id }, limit: 10 });
    expect(history.map((r) => r.actorUserId)).toEqual([founders[1], founders[0]]);
    const result = await controls.getState(context(), { target: { area: 'merchant', merchantId: id } });
    expect(result).toMatchObject({ version: '2', restricted: false });
    await expect(db.sql`UPDATE pay.account_control_audit SET result=result`).rejects.toThrow('pay.control_record_immutable');
    await expect(db.sql`DELETE FROM pay.account_control_audit`).rejects.toThrow('pay.control_record_immutable');
    await expect(db.sql`UPDATE pay.account_control_requests SET result=result`).rejects.toThrow('pay.control_record_immutable');
  });
  it('replay binds actor, full payload and current live authority', async () => {
    const id = await merchant(),
      input = command(id);
    const one = await controls.change(context(), input);
    expect(await controls.change(context(), input)).toEqual(one);
    expect((await controls.change(context(founders[1]), input)).outcome).toBe('refused');
    expect(await controls.change(context(), { ...input, reason: 'Different operation' })).toMatchObject({
      outcome: 'refused',
      code: 'request.conflict',
    });
    enabled = false;
    expect(await controls.change(context(), input)).toMatchObject({ outcome: 'refused', code: 'operator.denied', current: null });
  });
  it('concurrent commands with one version produce one change and one conflict', async () => {
    const id = await merchant();
    const results = await Promise.all([controls.change(context(), command(id)), controls.change(context(founders[1]), command(id))]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['changed', 'conflict']);
    expect((await controls.getState(context(), { target: { area: 'merchant', merchantId: id } }))?.version).toBe('1');
  });
  it('no-op and missing/closed targets produce durable truthful outcomes', async () => {
    const id = await merchant();
    await controls.change(context(), command(id));
    expect(await controls.change(context(), command(id, 'restrict', '1'))).toMatchObject({ outcome: 'noop', changed: false });
    expect(await controls.change(context(), command(randomUUID()))).toMatchObject({ outcome: 'refused', code: 'target.not_found' });
    const closed = await merchant('closed');
    expect(await controls.change(context(), command(closed, 'restore'))).toMatchObject({
      outcome: 'refused',
      code: 'restore.not_permitted',
    });
  });
  it('pending merchants restore to pending without granting KYB approval or active status', async () => {
    const id = await merchant('pending');
    await controls.change(context(), command(id));
    await controls.change(context(founders[1]), command(id, 'restore', '1'));
    const rows = await db.sql`SELECT status,kyb_status FROM pay.merchants WHERE id=${id}`;
    expect(rows[0]).toMatchObject({ status: 'pending', kyb_status: 'none' });
  });
  it('ordinary admins, API keys and missing MFA receive audited refusal without target disclosure', async () => {
    const id = await merchant();
    const ordinary = context(randomUUID());
    const api = context();
    api.principal = { ...api.principal!, kid: 'key' };
    const noMfa = context();
    noMfa.principal = { ...noMfa.principal!, mfa: false };
    const subaccount = context();
    subaccount.principal = { ...subaccount.principal!, sub_account: randomUUID() };
    const service = { ...context(), service: 'svc-admin' };
    for (const ctx of [ordinary, api, noMfa, subaccount, service]) {
      const result = await controls.change(ctx, command(id));
      expect(result).toMatchObject({ outcome: 'refused', changed: false, current: null });
      expect(accountControlResultSchema.safeParse(result).success).toBe(true);
    }
    expect((await controls.getState(context(), { target: { area: 'merchant', merchantId: id } }))?.restricted).toBe(false);
    await expect(controls.history(ordinary, { target: { area: 'merchant', merchantId: id }, limit: 10 })).rejects.toHaveProperty(
      'code',
      'operator.denied',
    );
  });
  async function preparedPayout(merchantId: string, port: IdentityOperationDecisionPort) {
    const settlementId = randomUUID(),
      userId = (await db.sql`SELECT user_id FROM pay.merchants WHERE id=${merchantId}`)[0]!.user_id as string;
    await db.sql`INSERT INTO pay.settlements(id,merchant_id,"window",asset_id,gross,fees,net,status) VALUES(${settlementId},${merchantId},'test-window','USDT','10','0','10','posted')`;
    return withPayoutLock(db.sql, settlementId, (connection) =>
      insertPayoutAdmission(
        connection,
        {
          settlement_id: settlementId,
          merchant_id: merchantId,
          merchant_user_id: userId,
          attempt: 0,
          business_id: settlementId,
          net: '10',
          asset_id: 'USDT',
          rail_id: 'crypto-native',
          destination_kind: 'crypto',
          destination_ref: '0x0000000000000000000000000000000000000f01',
          window: 'test-window',
        },
        async () => undefined,
        port,
      ),
    );
  }
  it('immutable prepared intent and request marker commit before the identity grant request', async () => {
    const id = await merchant();
    let called = false;
    const port: IdentityOperationDecisionPort = {
      decide: async (input) => {
        called = true;
        expect(await db.sql`SELECT id FROM pay.payout_admissions`).toHaveLength(1);
        expect(await db.sql`SELECT kind FROM pay.payout_outcomes WHERE kind='identity_requested'`).toHaveLength(1);
        return {
          status: 'granted',
          intent: input.intent,
          grantId: randomUUID(),
          identityVersion: '1',
          decidedAt: new Date().toISOString(),
        };
      },
    };
    const record = await preparedPayout(id, port);
    expect(called).toBe(false);
    await withPayoutLock(db.sql, record.settlement_id, (connection) =>
      finalizePayoutIdentity(connection, record, async () => undefined, port),
    );
    expect(called).toBe(true);
  });
  it('restriction resolves a lost grant acknowledgement and original admitted recovery remains permitted', async () => {
    const id = await merchant();
    let grant: unknown;
    const port: IdentityOperationDecisionPort = {
      decide: async (input) => {
        if (input.mode === 'grant') {
          grant = {
            status: 'granted',
            intent: input.intent,
            grantId: randomUUID(),
            identityVersion: '1',
            decidedAt: new Date().toISOString(),
          };
          throw new Error('Lost acknowledgement');
        }
        return grant as Awaited<ReturnType<IdentityOperationDecisionPort['decide']>>;
      },
    };
    const record = await preparedPayout(id, port);
    await expect(
      withPayoutLock(db.sql, record.settlement_id, (connection) => finalizePayoutIdentity(connection, record, async () => undefined, port)),
    ).rejects.toThrow('Lost acknowledgement');
    const guarded = new MerchantAccountControls(
      db.sql,
      async (ctx) => ctx.principal!.userId,
      (tx, merchantId) => drainPendingPayoutIdentityIntents(tx, merchantId, port),
    );
    expect((await guarded.change(context(), command(id))).outcome).toBe('changed');
    await withPayoutLock(db.sql, record.settlement_id, (connection) =>
      finalizePayoutIdentity(
        connection,
        record,
        async () => {
          throw new Error('Must not read fresh eligibility for original recovery');
        },
        port,
      ),
    );
    expect(await db.sql`SELECT kind FROM pay.payout_outcomes WHERE kind='identity_granted'`).toHaveLength(1);
  });
  it('pending marker cannot pass a committed restriction; cancellation is durably enforced on late retry', async () => {
    const id = await merchant();
    const port: IdentityOperationDecisionPort = {
      decide: async (input) => ({
        status: 'cancelled',
        intent: input.intent,
        code: 'admission.cancelled',
        decidedAt: new Date().toISOString(),
      }),
    };
    const record = await preparedPayout(id, port);
    const guarded = new MerchantAccountControls(
      db.sql,
      async (ctx) => ctx.principal!.userId,
      (tx, merchantId) => drainPendingPayoutIdentityIntents(tx, merchantId, port),
    );
    expect((await guarded.change(context(), command(id))).outcome).toBe('changed');
    await expect(
      withPayoutLock(db.sql, record.settlement_id, (connection) => finalizePayoutIdentity(connection, record, async () => undefined, port)),
    ).rejects.toHaveProperty('code', 'pay.identity_admission_denied');
  });
  it('missing, incomplete or unreachable pending-intent drains refuse the restriction without discarding intents', async () => {
    const id = await merchant(),
      port: IdentityOperationDecisionPort = { decide: async () => ({ status: 'unavailable', code: 'authority.unavailable' }) };
    await preparedPayout(id, port);
    for (const writer of [
      controls,
      new MerchantAccountControls(
        db.sql,
        async (ctx) => ctx.principal!.userId,
        async () => undefined,
      ),
      new MerchantAccountControls(
        db.sql,
        async (ctx) => ctx.principal!.userId,
        (tx, merchantId) => drainPendingPayoutIdentityIntents(tx, merchantId, port),
      ),
    ]) {
      expect(await writer.change(context(), command(id))).toMatchObject({ outcome: 'refused', code: 'authority.unavailable' });
    }
    expect(await controls.getState(context(), { target: { area: 'merchant', merchantId: id } })).toMatchObject({
      version: '0',
      restricted: false,
    });
    expect(await db.sql`SELECT id FROM pay.payout_admissions`).toHaveLength(1);
  });
  it('restriction waits for the same merchant SHARE admission guard', async () => {
    const id = await merchant();
    let release!: () => void;
    let locked!: () => void;
    const wait = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (locked = r));
    const admission = db.sql.begin(async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id=${id} FOR SHARE`;
      locked();
      await wait;
    });
    await ready;
    let changed = false;
    const request = controls.change(context(), command(id)).then((r) => {
      changed = true;
      return r;
    });
    for (let n = 0; n < 100; n++) {
      const rows =
        await db.sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'`;
      if (Number(rows[0]?.count) > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(changed).toBe(false);
    release();
    await admission;
    expect((await request).outcome).toBe('changed');
  });
});
