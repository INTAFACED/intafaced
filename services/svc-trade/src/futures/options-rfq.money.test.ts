/**
 * CARD E4 money proof — options RFQ (PTX-M11-R06 PTX-M12-R02).
 *
 * Hitch: quoteOptionsRfq refuses before any ledger post.
 * Unset principal/agency refuses. Undisclosed last look refuses.
 * Blank off-book cap does not inherit the book. matching/ not folded.
 * Not a redo of F8/#3769.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`, not shared table mutations).
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RFQ_CAPACITY_UNSET,
  RFQ_CAPACITY_UNSUPPORTED,
  RFQ_LAST_LOOK_UNDISCLOSED,
  RFQ_OFFBOOK_LEVERAGE_UNSET,
  checkOptionsRfq,
  quoteOptionsRfq,
} from './options-rfq.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const matchingRoot = join(here, '..', '..', '..', 'svc-matching');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
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
      `H8a: svc-trade options-rfq is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const OWNER = { capacity: 'principal', offBookLeverageCap: 5 } as const;

describe('options RFQ hitch (source) — matching not folded, book cap not inherited', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('options-rfq.ts refuses unset capacity and does not copy book leverage', () => {
    const mill = readFileSync(join(here, 'options-rfq.ts'), 'utf8');
    expect(mill).toMatch(/checkOptionsRfq/);
    expect(mill).toMatch(/quoteOptionsRfq/);
    expect(mill).toMatch(/TRADE_OPTIONS_RFQ_CAPACITY/);
    // #3771: the header comment reads "does NOT inherit the book's cap" (the test pinned a wording the source never had).
    expect(mill).toMatch(/NOT inherit the book's cap/);
    expect(mill).not.toMatch(/bookLeverageCap\s*\?\?/);
    expect(mill).not.toMatch(/offBookLeverageCap\s*=\s*book/);
  });

  it('router.ts / matching not recut', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/options-rfq/);
    expect(routerSrc).not.toMatch(/rfq_capacity_unset/);
    const matchingFiles = readdirSync(matchingRoot, { recursive: true, encoding: 'utf8' }) as string[];
    expect(matchingFiles.some((f) => String(f).includes('options-rfq'))).toBe(false);
    // The recursive walk of svc-matching (including node_modules) takes ~3s alone and exceeds 5s under CI/full-suite load.
  }, 30_000);
});

describe('options RFQ mill (hermetic)', () => {
  it('unset / blank / unknown capacity refuses', () => {
    expect(checkOptionsRfq({})).toMatchObject({ ok: false, code: RFQ_CAPACITY_UNSET });
    expect(checkOptionsRfq({ capacity: '' })).toMatchObject({ ok: false, code: RFQ_CAPACITY_UNSET });
    expect(checkOptionsRfq({ capacity: 'market_maker' })).toMatchObject({
      ok: false,
      code: RFQ_CAPACITY_UNSUPPORTED,
    });
  });

  it('undisclosed last look refuses', () => {
    expect(checkOptionsRfq({ capacity: 'agency', lastLook: true, offBookLeverageCap: OWNER.offBookLeverageCap })).toMatchObject({
      ok: false,
      code: RFQ_LAST_LOOK_UNDISCLOSED,
    });
    expect(
      checkOptionsRfq({
        capacity: 'agency',
        lastLook: true,
        lastLookDisclosed: true,
        offBookLeverageCap: OWNER.offBookLeverageCap,
      }),
    ).toMatchObject({ ok: true, capacity: 'agency' });
  });

  it('blank off-book cap refuses and does not inherit the book', () => {
    expect(checkOptionsRfq({ capacity: 'principal', bookLeverageCap: 20 })).toMatchObject({ ok: false, code: RFQ_OFFBOOK_LEVERAGE_UNSET });
    expect(checkOptionsRfq({ capacity: 'principal', offBookLeverageCap: '', bookLeverageCap: 20 })).toMatchObject({
      ok: false,
      code: RFQ_OFFBOOK_LEVERAGE_UNSET,
    });
    const admitted = checkOptionsRfq({
      capacity: OWNER.capacity,
      offBookLeverageCap: OWNER.offBookLeverageCap,
      bookLeverageCap: 20,
    });
    expect(admitted).toMatchObject({ ok: true, offBookLeverageCap: 5 });
    if (admitted.ok) expect(admitted.offBookLeverageCap).not.toBe(20);
  });
});

describe('svc-trade options RFQ E4 money', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('unset capacity: quoteOptionsRfq refuses; post is never called; zero journal', async () => {
    const ledger = new MemoryLedger();
    let posted = 0;
    const check = await quoteOptionsRfq({
      post: async () => {
        posted += 1;
        await ledger.post(
          recipes.deposit({
            userId: '11111111-1111-4111-8111-111111111111',
            assetId: 'USDT',
            amount: 1n,
            rail: 'test',
            railRef: 'e4-should-not',
          }),
        );
      },
    });
    expect(check).toMatchObject({ ok: false, code: RFQ_CAPACITY_UNSET });
    expect(posted).toBe(0);
    expect(ledger.journal()).toHaveLength(0);
  });

  it('undisclosed last look and blank off-book cap refuse with zero posts', async () => {
    const ledger = new MemoryLedger();
    let posted = 0;
    const post = async () => {
      posted += 1;
    };
    expect(await quoteOptionsRfq({ capacity: 'principal', lastLook: true, offBookLeverageCap: 5, post })).toMatchObject({
      ok: false,
      code: RFQ_LAST_LOOK_UNDISCLOSED,
    });
    expect(await quoteOptionsRfq({ capacity: 'principal', bookLeverageCap: 20, post })).toMatchObject({
      ok: false,
      code: RFQ_OFFBOOK_LEVERAGE_UNSET,
    });
    expect(posted).toBe(0);
    expect(ledger.journal()).toHaveLength(0);
  });
});
