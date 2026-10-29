import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { describe, expect, it, vi } from 'vitest';
import { VendorService } from '../vendor-service.js';
import { CommerceService } from './commerce-service.js';

const directory = new URL('../../drizzle/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, directory), 'utf8');
const baseline = readdirSync(directory)
  .filter((name) => /^000[0-4]_.*\.sql$/.test(name) && !name.endsWith('.down.sql'))
  .sort()
  .map(read);
const recovered = ['0005_market_purchase_status_lock.sql', '0006_market_purchase_snapshot.sql', '0007_market_purchase_access_window.sql'];
// The purchase path claims with a refund-window snapshot (0012). It adds a column and a table, nothing the upgrade tests read.
const purchasePath = ['0012_market_purchase_holds.sql'];
const url = process.env.TEST_DATABASE_URL?.trim();
if (!url) throw new Error('Purchase upgrade tests require an isolated TEST_DATABASE_URL');

async function fixture(): Promise<{ db: TestDatabase; purchaseId: string }> {
  const db = await createTestDatabase({ service: 'market', url, migrations: baseline });
  const vendor = randomUUID();
  const listing = randomUUID();
  const purchaseId = randomUUID();
  const vendorUser = randomUUID();
  try {
    await db.sql`INSERT INTO market.vendors (id, user_id, display_name, description, status) VALUES (${vendor}, ${vendorUser}, 'Fixture', 'Native upgrade', 'approved')`;
    await db.sql`INSERT INTO market.listings (id, vendor_id, title, description, offer_type, asset_id, price, period_seconds) VALUES (${listing}, ${vendor}, 'Feed', 'Hourly', 'subscription', 'USDT', 10, 3600)`;
    await db.sql`INSERT INTO market.purchases (id, listing_id, buyer_id, vendor_id, vendor_user_id, asset_id, price, commission_bps, status, ledger_tx_id, settled_at, access_until) VALUES (${purchaseId}, ${listing}, ${randomUUID()}, ${vendor}, ${vendorUser}, 'USDT', 10, 500, 'settled', ${randomUUID()}, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')`;
    return { db, purchaseId };
  } catch (err) {
    await db.drop();
    throw err;
  }
}

async function snapshot(db: TestDatabase, id: string) {
  const [row] = await db.sql`SELECT to_jsonb(p) AS row FROM market.purchases p WHERE id = ${id}`;
  return row!.row as Record<string, unknown>;
}

async function commerceFixture() {
  const { db } = await fixture();
  try {
    for (const name of [...recovered, ...purchasePath])
      await db.sql.begin(async (tx) => {
        await tx.unsafe(read(name));
      });
    const [listing] = await db.sql<Array<{ id: string; vendor_id: string }>>`SELECT id, vendor_id FROM market.listings`;
    await db.sql`INSERT INTO market.vendor_slots (vendor_id, ref) VALUES (${listing!.vendor_id}, ${listing!.id})`;
    const buyer = randomUUID();
    const ledger = new MemoryLedger();
    await ledger.post(recipes.deposit({ userId: buyer, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: randomUUID() }));
    const vendors = new VendorService(db.sql, { entitlementOf: async () => ({ tierName: 'fixture', vendorSlots: 1 }) });
    const commerce = new CommerceService(db.sql, vendors, ledger, { commissionBps: 500, now: () => new Date('2026-10-11T00:00:00Z') });
    return { db, listingId: listing!.id, buyer, ledger, commerce };
  } catch (err) {
    await db.drop();
    throw err;
  }
}

describe('purchase safeguards upgrade the populated public schema', () => {
  it('refuses losing a known paid period and still repairs the original paid window', async () => {
    const { db, listingId, buyer, commerce } = await commerceFixture();
    try {
      const paid = await commerce.purchase({ buyerId: buyer, listingId, purchaseId: randomUUID() });
      await db.sql`UPDATE market.purchases SET access_until = NULL WHERE id = ${paid.id}`;
      await db.sql`UPDATE market.listings SET period_seconds = 7200 WHERE id = ${listingId}`;
      const original = await snapshot(db, paid.id);
      await expect(
        db.sql.begin(async (tx) => {
          await tx.unsafe(read('0007_market_purchase_access_window.down.sql'));
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot(db, paid.id)).toEqual(original);
      expect((await commerce.subscriptionAccess({ buyerId: buyer, listingId })).accessUntil).toBe('2026-10-11T01:00:00.000Z');
    } finally {
      await db.drop();
    }
  });

  it('refuses losing a known pending period and re-drives the original claim after refusal', async () => {
    const { db, listingId, buyer, commerce, ledger } = await commerceFixture();
    const purchaseId = randomUUID();
    const post = vi.spyOn(ledger, 'post').mockRejectedValueOnce(new Error('claim retained before payment'));
    try {
      await expect(commerce.purchase({ buyerId: buyer, listingId, purchaseId })).rejects.toThrow('claim retained');
      post.mockRestore();
      await db.sql`UPDATE market.listings SET period_seconds = 7200 WHERE id = ${listingId}`;
      const original = await snapshot(db, purchaseId);
      expect(original.period_seconds).toBe(3600);
      await expect(
        db.sql.begin(async (tx) => {
          await tx.unsafe(read('0007_market_purchase_access_window.down.sql'));
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot(db, purchaseId)).toEqual(original);
      expect(await ledger.getTxByKey(`market.purchase:${purchaseId}`)).toBeNull();
      const paid = await commerce.purchase({ buyerId: buyer, listingId, purchaseId });
      expect(paid).toMatchObject({ status: 'settled', periodSeconds: 3600, accessUntil: '2026-10-11T01:00:00.000Z' });
    } finally {
      post.mockRestore();
      await db.drop();
    }
  });

  it('holds the guarded downgrade lock until DDL so a concurrent service claim cannot slip through', async () => {
    const { db, listingId, buyer, commerce, ledger } = await commerceFixture();
    const purchaseId = randomUUID();
    const downSql = read('0007_market_purchase_access_window.down.sql');
    const firstDdl = downSql.indexOf('DROP TRIGGER');
    expect(firstDdl).toBeGreaterThan(0);
    let locked!: () => void;
    let release!: () => void;
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const down = db.sql.begin(async (tx) => {
      await tx.unsafe(downSql.slice(0, firstDdl));
      locked();
      await releasePromise;
      await tx.unsafe(downSql.slice(firstDdl));
    });
    let claim: Promise<unknown> | undefined;
    try {
      await lockedPromise;
      claim = commerce.purchase({ buyerId: buyer, listingId, purchaseId }).catch((err: unknown) => err);
      const deadline = Date.now() + 2_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const [row] = await db.sql<
          Array<{ count: string }>
        >`SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%market.purchases%'`;
        if (Number(row!.count) > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(await ledger.getTxByKey(`market.purchase:${purchaseId}`)).toBeNull();
      release();
      await down;
      expect(await claim).toMatchObject({ code: '42703' });
      const [row] = await db.sql`SELECT count(*)::text AS count FROM market.purchases WHERE id = ${purchaseId}`;
      expect(row!.count).toBe('0');
      expect(await ledger.getTxByKey(`market.purchase:${purchaseId}`)).toBeNull();
      await db.sql.unsafe(read('0007_market_purchase_access_window.sql'));
    } finally {
      release();
      await down.catch(() => undefined);
      await claim;
      await db.drop();
    }
  });

  it('preserves original paid rows and unknown legacy periods across up/down/up', async () => {
    const { db, purchaseId } = await fixture();
    try {
      const original = await snapshot(db, purchaseId);
      for (const name of recovered)
        await db.sql.begin(async (tx) => {
          await tx.unsafe(read(name));
        });
      expect(await snapshot(db, purchaseId)).toEqual({ ...original, period_seconds: null });
      for (const name of [...recovered].reverse())
        await db.sql.begin(async (tx) => {
          await tx.unsafe(read(name.replace(/\.sql$/, '.down.sql')));
        });
      expect(await snapshot(db, purchaseId)).toEqual(original);
      for (const name of recovered)
        await db.sql.begin(async (tx) => {
          await tx.unsafe(read(name));
        });
      expect(await snapshot(db, purchaseId)).toEqual({ ...original, period_seconds: null });
    } finally {
      await db.drop();
    }
  });

  it('refuses contradictory old status fields without rewriting the paid receipt', async () => {
    const { db, purchaseId } = await fixture();
    try {
      await db.sql`UPDATE market.purchases SET rejection_code = 'legacy contradiction' WHERE id = ${purchaseId}`;
      const original = await snapshot(db, purchaseId);
      await expect(
        db.sql.begin(async (tx) => {
          await tx.unsafe(read(recovered[0]!));
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot(db, purchaseId)).toEqual(original);
    } finally {
      await db.drop();
    }
  });

  it('refuses a contradictory old payee without substituting the current vendor', async () => {
    const { db, purchaseId } = await fixture();
    try {
      await db.sql.unsafe(read(recovered[0]!));
      await db.sql`UPDATE market.purchases SET vendor_user_id = ${randomUUID()} WHERE id = ${purchaseId}`;
      const original = await snapshot(db, purchaseId);
      await expect(
        db.sql.begin(async (tx) => {
          await tx.unsafe(read(recovered[1]!));
        }),
      ).rejects.toMatchObject({ code: '23503' });
      expect(await snapshot(db, purchaseId)).toEqual(original);
    } finally {
      await db.drop();
    }
  });

  it('refuses an unbacked legacy access window without clearing its history', async () => {
    const { db, purchaseId } = await fixture();
    try {
      await db.sql`UPDATE market.purchases SET status = 'pending', ledger_tx_id = NULL, settled_at = NULL WHERE id = ${purchaseId}`;
      await db.sql.unsafe(read(recovered[0]!));
      await db.sql.unsafe(read(recovered[1]!));
      const original = await snapshot(db, purchaseId);
      await expect(
        db.sql.begin(async (tx) => {
          await tx.unsafe(read(recovered[2]!));
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot(db, purchaseId)).toEqual(original);
    } finally {
      await db.drop();
    }
  });
});
