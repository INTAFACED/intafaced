/**
 * Room access is the caller's own role on that business (M-adv-phantom-order-01).
 * A stranger and a missing merchant get the same not-found. A blank actor refuses.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { stubApprovalConsumer } from '../action-approval-consume.js';
import { teamReadFromSql } from '../merchant-team-read.js';
import { PayError, type PayService } from '../payment-service.js';
import { createMerchantPortalRouter } from './router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
const available = await postgresAvailable(URL);

const id = () => randomUUID();
const principalOf = (userId: string): Principal => ({
  userId,
  sub: userId,
  sid: id(),
  scopes: ['pay:read', 'pay:onboard'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
});
const ctxOf = (principal: Principal): Context => ({ principal, service: null, region: 'DE', requestId: id() });

function payLookup(sql: Sql): Pick<PayService, 'getMerchant' | 'getMerchantByUserId'> {
  const load = async (merchantId: string) => {
    const rows = await sql<
      Array<{
        id: string;
        user_id: string;
        mode: 'gateway' | 'psp' | 'payfac';
        status: 'pending' | 'active' | 'suspended' | 'closed';
        kyb_status: 'none' | 'pending' | 'approved' | 'rejected';
      }>
    >`
      SELECT id, user_id, mode::text AS mode, status::text AS status, kyb_status::text AS kyb_status
        FROM pay.merchants WHERE id = ${merchantId}`;
    const row = rows[0];
    if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
    return {
      id: row.id,
      userId: row.user_id,
      mode: row.mode,
      tier: 0,
      kybStatus: row.kyb_status,
      kybRef: null,
      status: row.status,
      pricing: {},
      settlementPrefs: {},
    };
  };
  return {
    getMerchant: load,
    async getMerchantByUserId(userId: string) {
      const rows = await sql<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE user_id = ${userId} LIMIT 1`;
      const found = rows[0];
      return found ? load(found.id) : null;
    },
  };
}

describe.skipIf(!available)('merchant.rooms.access', () => {
  let db: TestDatabase;
  const owner = id();
  const finance = id();
  const stranger = id();
  const merchantA = id();
  const merchantB = id();

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'pay', url: URL, migrations });
    const sql = db.sql;
    await sql`
      INSERT INTO pay.merchants (id, user_id, mode, status, kyb_status)
      VALUES
        (${merchantA}, ${owner}, 'gateway'::pay.merchant_mode, 'active'::pay.merchant_status, 'approved'::pay.kyb_status),
        (${merchantB}, ${stranger}, 'gateway'::pay.merchant_mode, 'active'::pay.merchant_status, 'none'::pay.kyb_status)`;
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantA}, ${finance}, 'finance', 'active', ${owner}, now())`;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  const caller = (userId: string) =>
    createMerchantPortalRouter({
      sql: db.sql,
      pay: payLookup(db.sql),
      trees: null,
      team: teamReadFromSql(db.sql),
      approvals: stubApprovalConsumer('approver'),
    }).createCaller(ctxOf(principalOf(userId)));

  it('returns finance room access and refuses a stranger the same way as a missing merchant', async () => {
    const view = await caller(finance).merchant.rooms.access({ merchantId: merchantA });
    expect(view.role).toBe('finance');
    const payout = view.rooms.find((room) => room.room === 'payout-new')?.actions.find((row) => row.action === 'payout.request');
    const send = view.rooms.find((room) => room.room === 'payout-new')?.actions.find((row) => row.action === 'payout.send');
    const refund = view.rooms.find((room) => room.room === 'refund-new')?.actions.find((row) => row.action === 'refund');
    expect(payout).toEqual({ action: 'payout.request', allowed: true, reason: 'step_up' });
    expect(send).toEqual({ action: 'payout.send', allowed: false, reason: 'role' });
    expect(refund).toEqual({ action: 'refund', allowed: false, reason: 'role' });

    const missingId = id();
    const foreign = caller(finance).merchant.rooms.access({ merchantId: merchantB });
    const missing = caller(finance).merchant.rooms.access({ merchantId: missingId });
    await expect(foreign).rejects.toMatchObject({ message: `Merchant ${merchantB} not found` });
    await expect(missing).rejects.toMatchObject({ message: `Merchant ${missingId} not found` });
  });

  it('refuses a blank actor', async () => {
    const blank = createMerchantPortalRouter({
      sql: db.sql,
      pay: payLookup(db.sql),
      trees: null,
      team: teamReadFromSql(db.sql),
      approvals: stubApprovalConsumer('approver'),
    }).createCaller(ctxOf(principalOf('   ')));
    await expect(blank.merchant.rooms.access({ merchantId: merchantA })).rejects.toMatchObject({
      message: 'pay.merchant_actor_required',
    });
  });
});
