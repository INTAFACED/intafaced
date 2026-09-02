/**
 * CARD F5 money proof — pre-trade credit dimensions refuse unset (PTX-M09-R10).
 *
 * Hitch: `checkPreTradeCredit` / `assertPreTradeCreditOrThrow` is the live mill
 * place/open jobs SHOULD call before hold/lock. Hosts currently do not invent
 * TRADE_MAX_* defaults. Mill has no default numbers and does not net dimensions.
 * Not a redo of F4/#3737. router.ts / trade-service.ts / position-service.ts /
 * index.ts / types.ts / ccxt-errors.ts not recut.
 *
 * Owner-published integers below are TEST FIXTURES only — never product law.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, afterAll } from 'vitest';
import { FuturesError } from './position-service.js';
import {
  MAX_LOSS_UNSET,
  MAX_ORDER_UNSET,
  MAX_POSITION_UNSET,
  TRADE_MAX_LOSS_ENV,
  TRADE_MAX_ORDER_QTY_ENV,
  TRADE_MAX_POSITION_ENV,
  assertPreTradeCreditOrThrow,
  checkOwnerPreTradeCredit,
  checkPreTradeCredit,
  readOwnerPreTradeCredit,
} from './pretrade-credit.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

/** Owner-published F5 fixtures — test labels only, never product law. Never copy into jobs/index. */
const OWNER_PUBLISHED_F5 = { maxOrder: 100, maxPosition: 1000, maxLoss: 50 } as const;

const CREDIT_KEYS = [TRADE_MAX_ORDER_QTY_ENV, TRADE_MAX_POSITION_ENV, TRADE_MAX_LOSS_ENV] as const;

function clearCreditEnv(): void {
  for (const key of CREDIT_KEYS) delete process.env[key];
}

describe('pre-trade credit hitch (source) — no invented caps, mill is the live refuse', () => {
  it('pretrade-credit.ts has no default numbers and does not net dimensions', () => {
    const mill = readFileSync(join(here, 'pretrade-credit.ts'), 'utf8');
    expect(mill).toMatch(/checkPreTradeCredit/);
    expect(mill).toMatch(/assertPreTradeCreditOrThrow/);
    expect(mill).toMatch(/parseOwnerIntegerEnv/);
    expect(mill).toMatch(/TRADE_MAX_ORDER_QTY/);
    expect(mill).toMatch(/TRADE_MAX_POSITION/);
    expect(mill).toMatch(/TRADE_MAX_LOSS/);
    expect(mill).toMatch(/n <= 0/);
    expect(mill).not.toMatch(/flatten/i);
    expect(mill).not.toMatch(/planClose/);
    expect(mill).not.toMatch(/closeAll/);
    expect(mill).not.toMatch(/maxOrder\s*=\s*0/);
    expect(mill).not.toMatch(/maxPosition\s*=\s*0/);
    expect(mill).not.toMatch(/maxLoss\s*=\s*0/);
    expect(mill).not.toMatch(/\?\?\s*0/);
    expect(mill).not.toMatch(/TRADE_MAX_ORDER.{0,80}default/i);
    expect(mill).not.toMatch(/installPreTradeCredit/);
  });

  it('router.ts not recut', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/pretrade-credit/);
    expect(routerSrc).not.toMatch(/max_order_unset/);
    expect(routerSrc).not.toMatch(/TRADE_MAX_ORDER/);
    expect(routerSrc).not.toMatch(/checkPreTradeCredit/);
  });

  it('position-service.ts / trade-service.ts currently do not invent limits', () => {
    const posSrc = readFileSync(join(here, 'position-service.ts'), 'utf8');
    const tradeSrc = readFileSync(join(here, '..', 'spot', 'trade-service.ts'), 'utf8');
    expect(posSrc).not.toMatch(/pretrade-credit/);
    expect(posSrc).not.toMatch(/max_order_unset/);
    expect(posSrc).not.toMatch(/TRADE_MAX_ORDER/);
    expect(posSrc).not.toMatch(/maxOrder\s*=\s*0/);
    expect(tradeSrc).not.toMatch(/pretrade-credit/);
    expect(tradeSrc).not.toMatch(/max_order_unset/);
    expect(tradeSrc).not.toMatch(/TRADE_MAX_ORDER/);
    expect(tradeSrc).not.toMatch(/maxOrder\s*=\s*0/);
  });

  it('futures-jobs.ts / index.ts do not invent TRADE_MAX_ORDER defaults', () => {
    const jobs = readFileSync(join(here, 'futures-jobs.ts'), 'utf8');
    const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(jobs).not.toMatch(/TRADE_MAX_ORDER/);
    expect(jobs).not.toMatch(/TRADE_MAX_POSITION/);
    expect(jobs).not.toMatch(/TRADE_MAX_LOSS/);
    expect(jobs).not.toMatch(/OWNER_PUBLISHED_F5/);
    expect(jobs).not.toMatch(/pretrade-credit/);
    expect(index).not.toMatch(/TRADE_MAX_ORDER/);
    expect(index).not.toMatch(/TRADE_MAX_POSITION/);
    expect(index).not.toMatch(/TRADE_MAX_LOSS/);
    expect(index).not.toMatch(/OWNER_PUBLISHED_F5/);
    expect(index).not.toMatch(/installPreTradeCredit/);
    expect(index).not.toMatch(/pretrade-credit/);
  });

  it('compose has no :-0 invented defaults for these keys if present', () => {
    const compose = readFileSync(join(repoRoot, 'docker-compose.apps.yml'), 'utf8');
    for (const key of CREDIT_KEYS) {
      expect(compose).not.toMatch(new RegExp(`${key}:\\s*\\$\\{${key}:-0\\}`));
    }
    // Keys are absent on origin/main — do not invent them.
    expect(compose).not.toMatch(/TRADE_MAX_ORDER_QTY/);
    expect(compose).not.toMatch(/TRADE_MAX_POSITION:/);
    expect(compose).not.toMatch(/TRADE_MAX_LOSS:/);
  });
});

describe('pre-trade credit mill (hermetic)', () => {
  it('unset each of three → matching code; ok false', () => {
    expect(
      checkPreTradeCredit({ maxOrder: undefined, maxPosition: OWNER_PUBLISHED_F5.maxPosition, maxLoss: OWNER_PUBLISHED_F5.maxLoss }),
    ).toMatchObject({
      ok: false,
      code: MAX_ORDER_UNSET,
    });
    expect(
      checkPreTradeCredit({ maxOrder: OWNER_PUBLISHED_F5.maxOrder, maxPosition: undefined, maxLoss: OWNER_PUBLISHED_F5.maxLoss }),
    ).toMatchObject({
      ok: false,
      code: MAX_POSITION_UNSET,
    });
    expect(
      checkPreTradeCredit({ maxOrder: OWNER_PUBLISHED_F5.maxOrder, maxPosition: OWNER_PUBLISHED_F5.maxPosition, maxLoss: undefined }),
    ).toMatchObject({
      ok: false,
      code: MAX_LOSS_UNSET,
    });
    expect(
      checkPreTradeCredit({ maxOrder: '', maxPosition: OWNER_PUBLISHED_F5.maxPosition, maxLoss: OWNER_PUBLISHED_F5.maxLoss }),
    ).toMatchObject({
      ok: false,
      code: MAX_ORDER_UNSET,
    });
    expect(
      checkPreTradeCredit({ maxOrder: null, maxPosition: OWNER_PUBLISHED_F5.maxPosition, maxLoss: OWNER_PUBLISHED_F5.maxLoss }),
    ).toMatchObject({
      ok: false,
      code: MAX_ORDER_UNSET,
    });
    expect(
      checkPreTradeCredit({ maxOrder: '1.5', maxPosition: OWNER_PUBLISHED_F5.maxPosition, maxLoss: OWNER_PUBLISHED_F5.maxLoss }),
    ).toMatchObject({
      ok: false,
      code: MAX_ORDER_UNSET,
    });
  });

  it('all three published (fixture 100/1000/50 labeled test-only) → ok', () => {
    expect(checkPreTradeCredit(OWNER_PUBLISHED_F5)).toEqual({ ok: true });
    expect(checkPreTradeCredit({ maxOrder: '100', maxPosition: '1000', maxLoss: '50' })).toEqual({ ok: true });
  });

  it('0 is unset not unlimited', () => {
    expect(
      checkPreTradeCredit({ maxOrder: 0, maxPosition: OWNER_PUBLISHED_F5.maxPosition, maxLoss: OWNER_PUBLISHED_F5.maxLoss }),
    ).toMatchObject({
      ok: false,
      code: MAX_ORDER_UNSET,
    });
    expect(
      checkPreTradeCredit({ maxOrder: OWNER_PUBLISHED_F5.maxOrder, maxPosition: 0, maxLoss: OWNER_PUBLISHED_F5.maxLoss }),
    ).toMatchObject({
      ok: false,
      code: MAX_POSITION_UNSET,
    });
    expect(
      checkPreTradeCredit({ maxOrder: OWNER_PUBLISHED_F5.maxOrder, maxPosition: OWNER_PUBLISHED_F5.maxPosition, maxLoss: 0 }),
    ).toMatchObject({
      ok: false,
      code: MAX_LOSS_UNSET,
    });
    expect(checkPreTradeCredit({ maxOrder: '0', maxPosition: '1000', maxLoss: '50' })).toMatchObject({ ok: false, code: MAX_ORDER_UNSET });
  });

  it('readOwnerPreTradeCredit blank env → unset; assert throws FuturesError mill codes', () => {
    const previous: Record<string, string | undefined> = {};
    for (const key of CREDIT_KEYS) previous[key] = process.env[key];
    try {
      clearCreditEnv();
      expect(readOwnerPreTradeCredit()).toEqual({ maxOrder: undefined, maxPosition: undefined, maxLoss: undefined });
      expect(checkOwnerPreTradeCredit()).toMatchObject({ ok: false, code: MAX_ORDER_UNSET });
      expect(() => assertPreTradeCreditOrThrow(readOwnerPreTradeCredit())).toThrow(FuturesError);
      try {
        assertPreTradeCreditOrThrow({ maxOrder: OWNER_PUBLISHED_F5.maxOrder, maxPosition: undefined, maxLoss: OWNER_PUBLISHED_F5.maxLoss });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FuturesError);
        expect((err as FuturesError).code).toBe(MAX_POSITION_UNSET);
        expect((err as FuturesError).status).toBe(400);
      }
      process.env[TRADE_MAX_ORDER_QTY_ENV] = String(OWNER_PUBLISHED_F5.maxOrder);
      process.env[TRADE_MAX_POSITION_ENV] = String(OWNER_PUBLISHED_F5.maxPosition);
      process.env[TRADE_MAX_LOSS_ENV] = String(OWNER_PUBLISHED_F5.maxLoss);
      expect(checkOwnerPreTradeCredit()).toEqual({ ok: true });
      expect(() => assertPreTradeCreditOrThrow()).not.toThrow();
    } finally {
      clearCreditEnv();
      for (const key of CREDIT_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-trade pre-trade credit F5 money (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'trade', url: URL, migrations });
  const sql = db.sql;

  describe('svc-trade pre-trade credit F5 money', () => {
    afterAll(async () => {
      await db.drop();
    }, 30_000);

    it('unset each dimension refuses matching mill code with postgres up; zero invented credit rows', async () => {
      const ping = await sql<{ n: string }[]>`SELECT 1::text AS n`;
      expect(ping[0]!.n).toBe('1');
      expect(
        checkPreTradeCredit({ maxOrder: undefined, maxPosition: OWNER_PUBLISHED_F5.maxPosition, maxLoss: OWNER_PUBLISHED_F5.maxLoss }),
      ).toMatchObject({
        ok: false,
        code: MAX_ORDER_UNSET,
      });
      expect(
        checkPreTradeCredit({ maxOrder: OWNER_PUBLISHED_F5.maxOrder, maxPosition: undefined, maxLoss: OWNER_PUBLISHED_F5.maxLoss }),
      ).toMatchObject({
        ok: false,
        code: MAX_POSITION_UNSET,
      });
      expect(
        checkPreTradeCredit({ maxOrder: OWNER_PUBLISHED_F5.maxOrder, maxPosition: OWNER_PUBLISHED_F5.maxPosition, maxLoss: undefined }),
      ).toMatchObject({
        ok: false,
        code: MAX_LOSS_UNSET,
      });
      expect(checkPreTradeCredit(OWNER_PUBLISHED_F5)).toEqual({ ok: true });
      expect(
        checkPreTradeCredit({ maxOrder: 0, maxPosition: OWNER_PUBLISHED_F5.maxPosition, maxLoss: OWNER_PUBLISHED_F5.maxLoss }),
      ).toMatchObject({
        ok: false,
        code: MAX_ORDER_UNSET,
      });
    });
  });
}
