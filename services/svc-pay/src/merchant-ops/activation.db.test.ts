import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { merchantActivationSchema } from '@intafaced/contracts/merchant-activation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { migrations, openAdmin } from '../control/control.testkit.js';
import { createFounderAuthority } from '../founder-authority.js';
import { MerchantAccountControls, MerchantControlError } from '../merchant-account-controls.js';
import { createMerchantOpsRouter } from './router.js';

/**
 * J-merchant-02 step 6 against a real Postgres: `merchantOps.activation.get` reads svc-pay's own status record, is
 * unconfirmed for a new business and after an approved verification, confirmed with the recorded time once a founder's
 * restore through `MerchantAccountControls.change` (the production door behind `accountControls.change` and
 * `merchantState.set`) moves it back to active, and never answers for another business.
 */
const id = () => randomUUID();
const principalOf = (userId: string, scopes: string[] = ['pay:read']): Principal => ({
  userId,
  sub: userId,
  sid: id(),
  scopes,
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
});
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: id(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { code: string; message: string; cause?: { code?: string } };
    return { code: err.code, message: err.message, cause: err.cause?.code };
  }
  throw new Error('expected a refusal');
}

describe('merchantOps.activation.get (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const founder = id();
  const founderAuthority = createFounderAuthority({ identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) });
  const as = (userId: string, scopes?: string[]) =>
    createMerchantOpsRouter({ sql, founderAuthority }).createCaller(ctxOf(principalOf(userId, scopes)));
  // Opened as `createMerchant` opens one: status `active`, no status-history row (the column's own default is `pending`).
  const newMerchant = async (userId: string) =>
    (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id, status) VALUES (${userId}, 'active') RETURNING id`)[0]!.id;
  // The production door: the founder console's restrict and restore. The founder check is identity's in production; here
  // only `founder` is entitled, as in merchant-account-controls.test.ts.
  const controls = () =>
    new MerchantAccountControls(sql, async (ctx) => {
      if (ctx.principal?.userId !== founder) throw new MerchantControlError('operator.denied');
      return ctx.principal.userId;
    });
  const control = async (merchantId: string, action: 'restrict' | 'restore') => {
    const version = (
      await sql<Array<{ v: string }>>`SELECT operations_control_version::text AS v FROM pay.merchants WHERE id = ${merchantId}`
    )[0]!.v;
    return controls().change(ctxOf(principalOf(founder, ['pay:read'])), {
      requestId: id(),
      target: { area: 'merchant', merchantId },
      action,
      reason: 'TEST founder note',
      expectedVersion: version,
    });
  };
  const statusRows = async (merchantId: string) =>
    sql<Array<{ to_status: string; created_at: Date; actor_scope: string }>>`
      SELECT to_status::text AS to_status, created_at, actor_scope
        FROM pay.merchant_status_events WHERE merchant_id = ${merchantId} ORDER BY seq`;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('a business that has just opened reads unconfirmed, on pay:onboard too', async () => {
    const owner = id();
    await newMerchant(owner);
    const read = await as(owner, ['pay:onboard']).merchantOps.activation.get({});
    expect(merchantActivationSchema.parse(read)).toEqual({
      activation: 'unconfirmed',
      status: 'active',
      activatedAt: null,
      reason: 'no_activation_record',
    });
  });

  it('an approved verification does not confirm an activation', async () => {
    const owner = id();
    const merchantId = await newMerchant(owner);
    // The verification's own writes: the status column and its history (the decision door itself is tested in kyb-service).
    await sql`UPDATE pay.merchants SET kyb_status = 'approved', kyb_ref = 'TEST-kyb-activation' WHERE id = ${merchantId}`;
    await sql`
      INSERT INTO pay.merchant_kyb_events (merchant_id, from_status, to_status, kyb_ref, reason, actor_id, actor_scope)
      VALUES (${merchantId}, 'none', 'pending', 'TEST-kyb-activation', 'TEST', ${owner}, 'pay:write'),
             (${merchantId}, 'pending', 'approved', 'TEST-kyb-activation', 'TEST', ${founder}, 'admin:compliance')`;
    expect((await sql`SELECT kyb_status FROM pay.merchants WHERE id = ${merchantId}`)[0]!.kyb_status).toBe('approved');
    expect(await as(owner).merchantOps.activation.get({})).toMatchObject({ activation: 'unconfirmed', reason: 'no_activation_record' });
  });

  it('a founder restore through the account controls confirms it with that row’s time, and a later restriction takes it away', async () => {
    const owner = id();
    const merchantId = await newMerchant(owner);
    expect((await control(merchantId, 'restrict')).outcome).toBe('changed');
    expect(await as(owner).merchantOps.activation.get({})).toEqual({
      activation: 'unconfirmed',
      status: 'suspended',
      activatedAt: null,
      reason: 'not_active',
    });
    expect((await control(merchantId, 'restore')).outcome).toBe('changed');
    const restored = await statusRows(merchantId);
    expect(restored.map((r) => [r.to_status, r.actor_scope])).toEqual([
      ['suspended', 'identity.operator_entitlement'],
      ['active', 'identity.operator_entitlement'],
    ]);
    const read = await as(owner).merchantOps.activation.get({});
    expect(read).toEqual({ activation: 'confirmed', status: 'active', activatedAt: restored[1]!.created_at.toISOString() });
    // A second restore is a no-op that writes no history, so the time stays the first activation's.
    expect((await control(merchantId, 'restore')).outcome).toBe('noop');
    expect(await as(owner).merchantOps.activation.get({})).toEqual(read);
    // A restriction takes the confirmation away: the answer is the state now, not the best state it ever had.
    expect((await control(merchantId, 'restrict')).outcome).toBe('changed');
    expect(await as(owner).merchantOps.activation.get({})).toEqual({
      activation: 'unconfirmed',
      status: 'suspended',
      activatedAt: null,
      reason: 'not_active',
    });
    // The history is append-only: the activation row is still there, unchanged.
    const rows = await statusRows(merchantId);
    expect(rows.map((r) => r.to_status)).toEqual(['suspended', 'active', 'suspended']);
    expect(rows[1]!.created_at.toISOString()).toBe(read.activatedAt);
  });

  it('a refused control writes nothing and confirms nothing', async () => {
    const owner = id();
    const merchantId = await newMerchant(owner);
    const refused = await controls().change(ctxOf(principalOf(owner, ['pay:read'])), {
      requestId: id(),
      target: { area: 'merchant', merchantId },
      action: 'restrict',
      reason: 'TEST not a founder',
      expectedVersion: '0',
    });
    expect(refused).toMatchObject({ outcome: 'refused', code: 'operator.denied' });
    expect(await statusRows(merchantId)).toEqual([]);
    expect(await as(owner).merchantOps.activation.get({})).toMatchObject({ activation: 'unconfirmed', reason: 'no_activation_record' });
  });

  it('reads only the caller’s own business: a stranger is refused like any merchantOps read', async () => {
    const owner = id();
    const merchantId = await newMerchant(owner);
    await control(merchantId, 'restrict');
    await control(merchantId, 'restore');
    expect(await as(owner).merchantOps.activation.get({})).toMatchObject({ activation: 'confirmed' });
    const stranger = await refusal(() => as(id()).merchantOps.activation.get({}));
    expect(stranger.cause).toBe('pay.merchant_ops_not_merchant');
    expect(stranger.message).not.toContain(merchantId);
    // A second business of a different owner reads its own state, not the first one's.
    const other = id();
    await newMerchant(other);
    expect(await as(other).merchantOps.activation.get({})).toMatchObject({ activation: 'unconfirmed' });
  });

  it('a team member reads it; an invited one does not', async () => {
    const owner = id();
    const merchantId = await newMerchant(owner);
    const viewer = id();
    const invited = id();
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantId}, ${viewer}, 'viewer', 'active', ${owner}, now()),
             (${merchantId}, ${invited}, 'viewer', 'invited', ${owner}, NULL)`;
    expect(await as(viewer).merchantOps.activation.get({})).toMatchObject({ activation: 'unconfirmed' });
    expect((await refusal(() => as(invited).merchantOps.activation.get({}))).cause).toBe('pay.merchant_ops_not_merchant');
  });
});
