import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { PayErrorCode } from './payment-service.js';
import { insertPayoutAdmission } from './payout-admission.js';
import { removeMerchantPayoutDestination } from './portal-reads/destinations.js';

/**
 * Destination remove takes FOR UPDATE. Payout admission takes FOR SHARE on the
 * same row, so the two cannot commit an insert and a delete over each other.
 * An admission with no outcome blocks remove only while it is inside the
 * merchant's configured payout approval TTL. 3600 here is the existing TEST
 * VALUE used by the control-room tier fixture, not a new business number.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_destination_lock_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

function fail(message: string, code: PayErrorCode): never {
  const error = new Error(message) as Error & { code: PayErrorCode };
  error.code = code;
  throw error;
}

describe('payout admission locks the destination it names', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = randomUUID();
  let merchantId = '';

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchantId = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  async function destination(railId: string, ref: string): Promise<string> {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref)
      VALUES (${merchantId}, ${railId}, 'crypto', ${ref})
      RETURNING id`;
    return rows[0]!.id;
  }

  async function settlement(window: string): Promise<string> {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
      VALUES (${merchantId}, ${window}, 'USDT', 1, 0, 1, 'posted')
      RETURNING id`;
    return rows[0]!.id;
  }

  it('holds FOR SHARE until the admission commits, so remove cannot delete the row in between', async () => {
    const destinationId = await destination('crypto-native', 'dest-lock-ref');
    const settlementId = await settlement('w-lock');
    const reserved = await sql.reserve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened!: () => void;
    const openedGate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let pending: Promise<unknown> | undefined;
    try {
      pending = insertPayoutAdmission(
        reserved,
        {
          settlement_id: settlementId,
          merchant_id: merchantId,
          merchant_user_id: owner,
          attempt: 0,
          business_id: `lock-${settlementId}`,
          net: '1',
          asset_id: 'USDT',
          rail_id: 'crypto-native',
          destination_kind: 'crypto',
          destination_ref: 'dest-lock-ref',
          window: 'w-lock',
        },
        async () => undefined,
        undefined,
        undefined,
        undefined,
        async () => {
          opened();
          await gate;
        },
      );
      await openedGate;
      let finished = false;
      const removal = removeMerchantPayoutDestination(sql, { merchantId, destinationId }, fail).then(
        (value) => {
          finished = true;
          return value;
        },
        (error: unknown) => {
          finished = true;
          throw error;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false);
      release();
      await pending;
      await expect(removal).rejects.toMatchObject({ code: 'pay.payout_destination_in_flight' });
    } finally {
      release();
      await pending?.catch(() => undefined);
      reserved.release();
    }
  }, 15_000);

  it('does not treat an admission older than the configured payout approval TTL as in flight', async () => {
    const freshId = await destination('card-sandbox', 'dest-fresh-ref');
    const staleId = await destination('bank-payout', 'dest-stale-ref');
    const freshSettlement = await settlement('w-fresh');
    const staleSettlement = await settlement('w-stale');
    const freshAdmission = randomUUID();
    const staleAdmission = randomUUID();
    await sql`
      INSERT INTO pay.payout_admissions (
        id, settlement_id, merchant_id, merchant_user_id, attempt, business_id,
        net, asset_id, rail_id, destination_kind, destination_ref, "window", merchant_control_version
      ) VALUES (
        ${freshAdmission}, ${freshSettlement}, ${merchantId}, ${owner}, 0, ${'fresh-' + freshAdmission},
        1, 'USDT', 'card-sandbox', 'crypto', 'dest-fresh-ref', 'w-fresh', 0
      )`;
    await sql`
      INSERT INTO pay.payout_admissions (
        id, settlement_id, merchant_id, merchant_user_id, attempt, business_id,
        net, asset_id, rail_id, destination_kind, destination_ref, "window", merchant_control_version, admitted_at
      ) VALUES (
        ${staleAdmission}, ${staleSettlement}, ${merchantId}, ${owner}, 0, ${'stale-' + staleAdmission},
        1, 'USDT', 'bank-payout', 'crypto', 'dest-stale-ref', 'w-stale', 0, now() - interval '2 hours'
      )`;
    await expect(removeMerchantPayoutDestination(sql, { merchantId, destinationId: freshId }, fail)).rejects.toMatchObject({
      code: 'pay.payout_destination_in_flight',
    });
    await expect(removeMerchantPayoutDestination(sql, { merchantId, destinationId: staleId }, fail)).rejects.toMatchObject({
      code: 'pay.payout_destination_in_flight',
    });
    await sql`
      INSERT INTO pay.control_tiers (
        id, name, archetype, caps, approval_thresholds, founder_thresholds, approval_ttl_seconds, updated_by
      ) VALUES (
        'test-tier', 'TEST VALUE', 'standard', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 3600, 'test'
      )`;
    await sql`
      INSERT INTO pay.control_merchant_profiles (merchant_id, tier_id)
      VALUES (${merchantId}, 'test-tier')`;
    expect(await removeMerchantPayoutDestination(sql, { merchantId, destinationId: staleId }, fail)).toEqual({ removed: true });
    await expect(removeMerchantPayoutDestination(sql, { merchantId, destinationId: freshId }, fail)).rejects.toMatchObject({
      code: 'pay.payout_destination_in_flight',
    });
  });
});
