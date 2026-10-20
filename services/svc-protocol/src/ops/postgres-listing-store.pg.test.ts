/**
 * Listing overrides in Postgres (D-order-controls-04).
 *
 * Promise: a decision and its state change land together or not at all; a decision key already stored returns the stored
 * decision and writes nothing; a restore flips the state back; the real migration applies and its reversal refuses while a
 * decision exists.
 * Break: a retry writes a second decision or overwrites the state; a hide is stored without who signed it; the reversal
 * silently drops the log.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { listingDecisions, listingOverrides } from '../db/schema.js';
import type { ListingDecision } from './listing.js';
import { PostgresListingStore } from './postgres-listing-store.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = files.map((f) => readFileSync(join(dir, f), 'utf8'));
const down = readFileSync(join(dir, '0001_listing_overrides.down.sql'), 'utf8');

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');

const decision = (over: Partial<ListingDecision> = {}): ListingDecision => ({
  idempotencyKey: 'protocol.pool.hide:84532:0xabc:ap_1',
  action: 'protocol.pool.hide',
  kind: 'pool',
  targetId: '84532:0xabc',
  outcome: 'applied',
  note: null,
  state: 'hidden',
  reasonCode: 'scam_report',
  reason: 'reported',
  approvalId: 'ap_1',
  requesterId: 'founder-a',
  approverId: 'founder-b',
  policyVersion: 'policy-1',
  ...over,
});
const row = (over = {}) => ({
  kind: 'pool' as const,
  targetId: '84532:0xabc',
  state: 'hidden' as const,
  reasonCode: 'scam_report',
  reason: 'reported',
  approvalId: 'ap_1',
  policyVersion: 'policy-1',
  ...over,
});

describe('PostgresListingStore', () => {
  let db: TestDatabase;
  let store: PostgresListingStore;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'protocol', url: rawUrl, migrations });
    store = new PostgresListingStore(drizzle(db.sql, { schema: { listingOverrides, listingDecisions } }));
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);
  beforeEach(async () => {
    await db.sql`TRUNCATE protocol.listing_decisions, protocol.listing_overrides`;
  });

  it('stores the decision with both signatures and the state together, and lists the hidden target', async () => {
    await store.record(decision(), row());
    expect(await store.decision('protocol.pool.hide:84532:0xabc:ap_1')).toMatchObject({
      requesterId: 'founder-a',
      approverId: 'founder-b',
      policyVersion: 'policy-1',
    });
    expect(await store.state('pool', '84532:0xabc')).toMatchObject({ state: 'hidden', approvalId: 'ap_1' });
    expect((await store.list('pool')).map((r) => r.targetId)).toEqual(['84532:0xabc']);
    expect(await store.list('market')).toEqual([]);
  });

  it('returns the stored decision for a repeated key and neither re-writes it nor moves the state', async () => {
    await store.record(decision(), row());
    const again = await store.record(decision({ note: 'changed', reason: 'other' }), row({ state: 'visible', approvalId: 'ap_2' }));
    expect(again.note).toBeNull();
    expect(again.reason).toBe('reported');
    expect(await store.state('pool', '84532:0xabc')).toMatchObject({ state: 'hidden', approvalId: 'ap_1' });
    const [{ count }] = await db.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM protocol.listing_decisions`;
    expect(count).toBe('1');
  });

  it('flips back to visible on a restore, and logs a no-op without touching the state', async () => {
    await store.record(decision(), row());
    await store.record(
      decision({
        idempotencyKey: 'k2',
        action: 'protocol.pool.restore',
        state: 'visible',
        reasonCode: null,
        reason: null,
        approvalId: 'ap_2',
      }),
      row({ state: 'visible', reasonCode: null, reason: null, approvalId: 'ap_2' }),
    );
    expect((await store.state('pool', '84532:0xabc'))?.state).toBe('visible');
    await store.record(decision({ idempotencyKey: 'k3', outcome: 'noop', approvalId: 'ap_3' }), null);
    expect((await store.state('pool', '84532:0xabc'))?.approvalId).toBe('ap_2');
    expect((await store.decision('k3'))?.outcome).toBe('noop');
  });

  it('refuses a state or kind the table does not know', async () => {
    await expect(store.record(decision({ idempotencyKey: 'bad' }), row({ state: 'frozen' as never }))).rejects.toThrow();
    expect(await store.decision('bad')).toBeNull();
  });

  it('refuses to roll back while a decision exists, and drops the tables once the log is empty', async () => {
    await store.record(decision(), row());
    await expect(db.sql.unsafe(down)).rejects.toThrow(/listing decisions exist/);
    await db.sql`TRUNCATE protocol.listing_decisions, protocol.listing_overrides`;
    await db.sql.unsafe(down);
    const [{ present }] = await db.sql<{ present: string | null }[]>`SELECT to_regclass('protocol.listing_decisions')::text AS present`;
    expect(present).toBeNull();
  });
});
