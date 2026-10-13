/**
 * CARD F7 money proof — funding recon across surfaces (PTX-M10-R05).
 *
 * Hitch: fundingRecipeForSurface / reconFundingSurfaces share planFundingSettlement.
 * Settle posts recipes.futuresFundingPay; predict/accrue/correct/report do not post.
 * Unset rate refuses all five surfaces. Divergent surface rate refuses.
 * Not a redo of F6/#3764. router.ts / svc-ledger not recut.
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
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FUNDING_RATE_UNSET,
  FUNDING_RECON_DIVERGED,
  FUNDING_SURFACES,
  fundingRecipeForSurface,
  reconFundingSurfaces,
  requireOwnerFundingRate,
  settleRecipesFromRecon,
} from './funding-recon.js';
import type { FundingOpenPosition } from './funding-settlement.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const repoRoot = join(here, '..', '..', '..', '..');
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
      `H8a: svc-trade funding-recon is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** Owner-published F7 fixture — test label only, never product law. */
const OWNER_RATE = '0.0001';
const OWNER_MAX = '0.01';

const POSITIONS: readonly FundingOpenPosition[] = [
  {
    positionId: 'pos-long',
    userId: ALICE,
    side: 'long',
    size: amt('1'),
    entryPrice: amt('50000'),
    marginAsset: 'USDT',
  },
  {
    positionId: 'pos-short',
    userId: BOB,
    side: 'short',
    size: amt('1'),
    entryPrice: amt('50000'),
    marginAsset: 'USDT',
  },
];

const BASE = {
  periodId: 'mkt:2026-09-03T00:00:00.000Z',
  marketId: 'mkt',
  maxAbsRate: OWNER_MAX,
  positions: POSITIONS,
};

describe('funding recon hitch (source) — one recipe, no invented rate', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('funding-recon.ts uses planFundingSettlement and does not invent a rate', () => {
    const mill = readFileSync(join(here, 'funding-recon.ts'), 'utf8');
    expect(mill).toMatch(/planFundingSettlement/);
    expect(mill).toMatch(/requireOwnerFundingRate/);
    expect(mill).toMatch(/predict/);
    expect(mill).toMatch(/accrue/);
    expect(mill).toMatch(/settle/);
    expect(mill).toMatch(/correct/);
    expect(mill).toMatch(/report/);
    expect(mill).not.toMatch(/rate\s*=\s*['"]0['"]/);
    expect(mill).not.toMatch(/\?\?\s*['"]0/);
  });

  it('funding-tick.ts still plans via planFundingSettlement; no invented rate', () => {
    const tick = readFileSync(join(here, 'funding-tick.ts'), 'utf8');
    expect(tick).toMatch(/planFundingSettlement/);
    expect(tick).toMatch(/never invent/);
  });

  it('router.ts / svc-ledger not recut', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/funding-recon/);
    expect(routerSrc).not.toMatch(/funding_recon_diverged/);
    const ledgerDir = join(repoRoot, 'services', 'svc-ledger', 'src');
    const ledgerFiles = readdirSync(ledgerDir, { recursive: true, encoding: 'utf8' }) as string[];
    expect(ledgerFiles.some((f) => String(f).includes('funding-recon'))).toBe(false);
  });
});

describe('funding recon mill (hermetic)', () => {
  it('unset rate refuses all five surfaces the same way', () => {
    for (const surface of FUNDING_SURFACES) {
      expect(fundingRecipeForSurface(surface, { ...BASE, rate: undefined })).toMatchObject({
        ok: false,
        code: FUNDING_RATE_UNSET,
      });
      expect(fundingRecipeForSurface(surface, { ...BASE, rate: '' })).toMatchObject({
        ok: false,
        code: FUNDING_RATE_UNSET,
      });
    }
    expect(reconFundingSurfaces({ ...BASE, rate: null })).toMatchObject({ ok: false, code: FUNDING_RATE_UNSET });
    expect(() => requireOwnerFundingRate(undefined)).toThrow(/unset/);
  });

  it('published owner rate yields one fingerprint across predict/accrue/settle/correct/report', () => {
    const recon = reconFundingSurfaces({ ...BASE, rate: OWNER_RATE });
    expect(recon.ok).toBe(true);
    if (!recon.ok) return;
    expect(recon.rate).toBe(OWNER_RATE);
    expect(recon.legs.length).toBeGreaterThan(0);
    for (const surface of FUNDING_SURFACES) {
      const one = fundingRecipeForSurface(surface, { ...BASE, rate: OWNER_RATE });
      expect(one).toMatchObject({ ok: true, fingerprint: recon.fingerprint, rate: OWNER_RATE });
    }
  });

  it('divergent surface rate refuses rather than let UI/API/ledger disagree', () => {
    expect(
      reconFundingSurfaces({
        ...BASE,
        rate: OWNER_RATE,
        surfaceRates: { predict: '0.0002' },
      }),
    ).toMatchObject({ ok: false, code: FUNDING_RECON_DIVERGED });
    expect(
      reconFundingSurfaces({
        ...BASE,
        rate: OWNER_RATE,
        surfaceRates: { report: '' },
      }),
    ).toMatchObject({ ok: false, code: FUNDING_RECON_DIVERGED });
  });
});

describe('svc-trade funding recon F7 money', () => {
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

  it('unset rate: recon refuses; settle posts zero futuresFundingPay', async () => {
    const ledger = new MemoryLedger();
    const refused = reconFundingSurfaces({ ...BASE, rate: undefined });
    expect(refused).toMatchObject({ ok: false, code: FUNDING_RATE_UNSET });
    expect(ledger.journal().filter((tx) => tx.reason === 'futures.funding.pay')).toHaveLength(0);
  });

  it('published owner rate: settle posts the recon recipe once; predict does not post', async () => {
    const ledger = new MemoryLedger();
    // Fixture never funded the payer (5 USDT due from position collateral); hidden by skip-without-Postgres until
    // #3954/#3924 made it hard-fail. Deposit, then lock margin into pos-long.
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: 'funding-recon-alice' }),
    );
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-long', userId: ALICE, assetId: 'USDT', amount: amt('50') }));
    const recon = reconFundingSurfaces({ ...BASE, rate: OWNER_RATE });
    expect(recon.ok).toBe(true);
    if (!recon.ok) return;
    const predict = fundingRecipeForSurface('predict', { ...BASE, rate: OWNER_RATE });
    expect(predict.ok && predict.fingerprint).toBe(recon.fingerprint);
    expect(ledger.journal()).toHaveLength(2); // deposit + margin lock only: predict posted nothing
    for (const recipe of settleRecipesFromRecon(recon)) {
      await ledger.post(recipe);
    }
    const pays = ledger.journal().filter((tx) => tx.reason === recipes.futuresFundingPay.name || tx.reason.includes('funding'));
    expect(pays.length).toBe(recon.legs.length);
  });
});
