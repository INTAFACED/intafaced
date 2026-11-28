/**
 * CARD R-promo — create-promo mill (budget/end refuse; no invented rebate bps).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tradeEnvOf, tradeRouterPaths } from '../__tests__/entry.js';
import {
  PROMO_BUDGET_ENV,
  PROMO_BUDGET_UNSET,
  PROMO_END_ENV,
  PROMO_END_UNSET,
  PROMO_IEEE,
  checkCreatePromo,
  promoOwnerEnvComposeWired,
  runCreatePromo,
} from './promo.js';

const SOCKETS = [PROMO_BUDGET_ENV, PROMO_END_ENV] as const;

const previous: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const key of SOCKETS) previous[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of SOCKETS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

function clearSockets(): void {
  for (const key of SOCKETS) delete process.env[key];
}

describe('R-promo create-promo mill — budget/end refuse by name', () => {
  snapshotEnv();
  afterEach(restoreEnv);

  it('blank budget refuses before inventing an end or rebate', () => {
    clearSockets();
    expect(checkCreatePromo({})).toEqual({
      ok: false,
      code: PROMO_BUDGET_UNSET,
      reason: 'TRADE_PROMO_BUDGET is unset — refuse create-promo rather than invent a budget',
      created: false,
      posted: false,
      rebateBps: null,
    });
    expect(checkCreatePromo({ end: '2026-12-31T00:00:00.000Z', rebateBps: '10' })).toMatchObject({
      ok: false,
      code: PROMO_BUDGET_UNSET,
      rebateBps: null,
    });
  });

  it('budget without end refuses — never invents a sunset', () => {
    clearSockets();
    expect(checkCreatePromo({ budget: '1000.00' })).toMatchObject({
      ok: false,
      code: PROMO_END_UNSET,
      created: false,
      rebateBps: null,
    });
    expect(checkCreatePromo({ budget: '1000.00', end: '  ' })).toMatchObject({
      ok: false,
      code: PROMO_END_UNSET,
    });
  });

  it('IEEE budget or rebate bps refuse — never a JS number on the wire', () => {
    clearSockets();
    expect(checkCreatePromo({ budget: 1000, end: '2026-12-31T00:00:00.000Z' })).toMatchObject({
      ok: false,
      code: PROMO_IEEE,
      rebateBps: null,
    });
    expect(checkCreatePromo({ budget: '1000', end: '2026-12-31T00:00:00.000Z', rebateBps: 10 })).toMatchObject({
      ok: false,
      code: PROMO_IEEE,
      rebateBps: null,
    });
  });

  it('absent funding grants no rebate even when bps are offered', () => {
    clearSockets();
    const result = checkCreatePromo({
      budget: '0',
      end: '2026-12-31T00:00:00.000Z',
      rebateBps: '10',
    });
    expect(result).toEqual({
      ok: true,
      preview: true,
      created: false,
      posted: false,
      funded: false,
      budget: '0',
      end: '2026-12-31T00:00:00.000Z',
      rebateBps: null,
    });
  });

  it('funded budget+end preview — rebate only if owner string, never invented 10/20', () => {
    clearSockets();
    const withoutBps = checkCreatePromo({
      budget: '1000.00',
      end: '2026-12-31T00:00:00.000Z',
    });
    expect(withoutBps).toEqual({
      ok: true,
      preview: true,
      created: false,
      posted: false,
      funded: true,
      budget: '1000',
      end: '2026-12-31T00:00:00.000Z',
      rebateBps: null,
    });
    const withBps = checkCreatePromo({
      budget: '1000.00',
      end: '2026-12-31T00:00:00.000Z',
      rebateBps: '25',
    });
    expect(withBps).toMatchObject({ ok: true, funded: true, rebateBps: '25', created: false });
  });

  it('reads owner env when input omits sockets', () => {
    process.env[PROMO_BUDGET_ENV] = '50.00';
    process.env[PROMO_END_ENV] = '2027-01-01T00:00:00.000Z';
    expect(checkCreatePromo({})).toMatchObject({
      ok: true,
      budget: '50',
      end: '2027-01-01T00:00:00.000Z',
      created: false,
      rebateBps: null,
    });
  });
});

describe('R-promo hitch — no recipe, no router recut, compose empty', () => {
  it('mill does not post recipes or invent rebate bps', async () => {
    const posted: unknown[] = [];
    const post = async (recipe: unknown) => void posted.push(recipe);
    const cases = [
      {},
      { budget: '1000.00' },
      { budget: '1000.00', end: '2026-12-31T00:00:00.000Z' },
      { budget: '1000.00', end: '2026-12-31T00:00:00.000Z', rebateBps: '25' },
      { budget: 1000, end: '2026-12-31T00:00:00.000Z' },
    ];
    for (const input of cases) {
      const result = await runCreatePromo({ ...input, post });
      expect(result, JSON.stringify(input)).toMatchObject({ created: false, posted: false });
      // A rebate is only ever the owner's string: none offered, none invented (no 10, no 20).
      if (!('rebateBps' in input)) expect(result.rebateBps).toBeNull();
    }
    expect(posted).toEqual([]);
  });

  it('router.ts not recut; index.ts mounts the door', () => {
    // Promotions are their own REST door (index.boot.test.ts: 'mounts the greeks what-if, delta-hedge and promo doors').
    expect(tradeRouterPaths().filter((path) => /promo/i.test(path))).toEqual([]);
  });

  it('compose passes budget/end with empty default', () => {
    expect(promoOwnerEnvComposeWired()).toBe(true);
  });

  it('env schema defaults the two sockets empty — never invents a budget', () => {
    const unset = tradeEnvOf();
    expect(unset.TRADE_PROMO_BUDGET).toBe('');
    expect(unset.TRADE_PROMO_END).toBe('');
  });
});
