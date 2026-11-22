import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPostgres } from '@intafaced/db/test-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger } from '@intafaced/ledger-client';
import { InstrumentService } from './instrument-service.js';
import { MerchantService } from './merchant-service.js';
import { P2pError, P2pService } from './p2p-service.js';

/**
 * First approval must re-read live reputation the same way unfreeze already
 * does. Apply-time eligibility is not a voucher that survives a later dispute
 * loss while the row sits at `applied`.
 *
 * Public `offers.create` still named-refuses until OWNER KMS (Q-p2p). This
 * file drives `MerchantService` + `P2pService.reputationOf` only — no offers,
 * no method-registry seed. Fixture rails are not a live method registry.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `p2p.*` SQL stays on `p2p`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const APPLICANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await testPostgres(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-p2p merchant-service is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('merchant-service first-approval eligibility PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('first approval — live reputation, not the apply-time snapshot', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let instruments!: InstrumentService;
  let ledger!: MemoryLedger;
  let bus!: MemoryEventBus;
  let p2p!: P2pService;
  let merchants!: MerchantService;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'p2p', url: admin.url, migrations });
    sql = db.sql;
    instruments = new InstrumentService(sql);
  }, 120_000);

  async function seedReputation(over: { disputed?: number; disputesLost?: number } = {}): Promise<void> {
    const disputed = over.disputed ?? 0;
    const disputesLost = over.disputesLost ?? 0;
    await sql`
      INSERT INTO p2p.p2p_reputation (
        user_id, trades_total, completed, cancelled, disputed, disputes_lost,
        completion_rate, total_release_secs, release_samples, avg_release_secs, badges
      )
      VALUES (
        ${APPLICANT}, 20, 20, 0, ${disputed}, ${disputesLost},
        1, 200, 20, 10, '{}'::text[]
      )
      ON CONFLICT (user_id) DO UPDATE SET
        disputed = EXCLUDED.disputed,
        disputes_lost = EXCLUDED.disputes_lost,
        updated_at = now()
    `;
  }

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-p2p');
    p2p = new P2pService(sql, ledger, bus, { instruments });
    merchants = new MerchantService(sql, p2p);
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('REFUSES applied → approved after a dispute loss that apply would now refuse', async () => {
    await seedReputation();
    const applied = await merchants.apply(APPLICANT, 'p2p:write');
    expect(applied.status).toBe('applied');

    await seedReputation({ disputed: 1, disputesLost: 1 });

    await expect(
      merchants.transition({
        userId: APPLICANT,
        to: 'approved',
        by: 'operator',
        reason: 'operator first approve',
        actorId: OPERATOR,
        actorScope: 'admin:compliance',
      }),
    ).rejects.toMatchObject({ code: 'p2p.merchant_ineligible' });

    expect((await merchants.get(APPLICANT))?.status).toBe('applied');
  });

  it('approves when the live snapshot still meets the apply rule', async () => {
    await seedReputation();
    await merchants.apply(APPLICANT, 'p2p:write');

    const approved = await merchants.transition({
      userId: APPLICANT,
      to: 'approved',
      by: 'operator',
      reason: 'operator first approve',
      actorId: OPERATOR,
      actorScope: 'admin:compliance',
    });

    expect(approved.status).toBe('approved');
    expect(approved.decidedAt).not.toBeNull();
  });

  it('still refuses unfreeze after a moderated loss — same sentence family', async () => {
    await seedReputation();
    await merchants.apply(APPLICANT, 'p2p:write');
    await merchants.transition({
      userId: APPLICANT,
      to: 'approved',
      by: 'operator',
      reason: 'operator first approve',
      actorId: OPERATOR,
      actorScope: 'admin:compliance',
    });
    await merchants.transition({
      userId: APPLICANT,
      to: 'suspended',
      by: 'operator',
      reason: 'operator freeze',
      actorId: OPERATOR,
      actorScope: 'admin:compliance',
    });

    await seedReputation({ disputed: 1, disputesLost: 1 });

    await expect(
      merchants.transition({
        userId: APPLICANT,
        to: 'approved',
        by: 'operator',
        reason: 'operator unfreeze',
        actorId: OPERATOR,
        actorScope: 'admin:compliance',
      }),
    ).rejects.toBeInstanceOf(P2pError);
  });
});
