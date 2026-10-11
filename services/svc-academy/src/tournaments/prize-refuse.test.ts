import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TournamentError } from './ladder.js';
import {
  PRIZE_POOL_CLASS_M_RESIDUAL,
  PRIZE_POOL_UNSET_CODE,
  PRIZE_POOL_UNSET_RESIDUAL,
  PRIZE_REFUSE_CODE,
  PrizePoolRefuseError,
  assertMayStartPrizeSeason,
  assertNoPrizeAttachment,
  decidePrizeIntent,
  decidePrizePoolStart,
  isPrizePoolUnset,
  isPrizePoolUnsetRefuse,
  isPrizeRefuseClosed,
  prizePoolStartRefuseExportHeader,
  prizePoolStartRefuseExportLine,
  prizePoolUnsetResidualIsHonest,
  prizeRefuseStatusLine,
  refuseFundPrizePool,
  refuseInventPrizeBalance,
  refusePrizeClawback,
  refusePrizeEscrow,
  refusePrizePayout,
  refuseUnsetPrizePoolStart,
  tryRefusePrizePoolStart,
} from './prize-refuse.js';

describe('tournament Stage-3 IFC prizes refuse-closed', () => {
  it('refuses fund / payout / escrow / clawback / invent', () => {
    for (const d of [
      refuseFundPrizePool(),
      refusePrizePayout(),
      refusePrizeEscrow(),
      refusePrizeClawback(),
      refuseInventPrizeBalance(),
      decidePrizeIntent('fund_pool'),
    ]) {
      expect(d.status).toBe('refuse');
      expect(d.code).toBe(PRIZE_REFUSE_CODE);
      expect(d.academyHoldsPrizeBalance).toBe(false);
      expect(d.ledgerRecipeReady).toBe(false);
      expect(isPrizeRefuseClosed(d)).toBe(true);
      expect(d.message).toMatch(/refuse-closed/);
    }
  });

  it('assertNoPrizeAttachment allows rank-only freeze payloads', () => {
    expect(() => assertNoPrizeAttachment({ seasonId: 's1', standings: [], frozenAt: new Date() })).not.toThrow();
    expect(() => assertNoPrizeAttachment(null)).not.toThrow();
  });

  it('assertNoPrizeAttachment throws on invent prize fields', () => {
    expect(() => assertNoPrizeAttachment({ prize: '10.00' })).toThrow(TournamentError);
    expect(() => assertNoPrizeAttachment({ prizePool: { amount: '1' } })).toThrow(TournamentError);
    expect(() => assertNoPrizeAttachment({ ifcPrize: 1 })).toThrow(TournamentError);
    expect(() => assertNoPrizeAttachment({ payout: true })).toThrow(TournamentError);
    expect(() => assertNoPrizeAttachment({ escrowAmount: '0' })).toThrow(TournamentError);
    expect(() => assertNoPrizeAttachment({ poolBalance: '0' })).toThrow(TournamentError);
  });

  it('assertNoPrizeAttachment rejects amount, ifcAmount, and a prize nested in standings', () => {
    const cases = [{ amount: '1000.00' }, { ifcAmount: '10.00' }, { standings: [{ prize: '10.00' }] }] as const;
    for (const payload of cases) {
      let thrown: unknown;
      try {
        assertNoPrizeAttachment(payload);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(TournamentError);
      expect((thrown as TournamentError).code).toBe('academy.season_invalid');
    }
    expect(() =>
      assertNoPrizeAttachment({
        seasonId: 's1',
        standings: [{ seasonId: 's1', userId: 'u1', score: 3, rank: 1 }],
      }),
    ).not.toThrow();
  });

  it('status line is honest — no ledger, no invent IFC, unset code greppable', () => {
    expect(prizeRefuseStatusLine()).toBe(
      `prizes=refuse_closed code=${PRIZE_REFUSE_CODE} unset=${PRIZE_POOL_UNSET_CODE} ledger=0 inventIfc=0`,
    );
  });
});

describe('D26-P1-C3 prize pools refuse if unset — no invent IFC', () => {
  it('detects blank / missing pool as unset', () => {
    expect(isPrizePoolUnset(null)).toBe(true);
    expect(isPrizePoolUnset(undefined)).toBe(true);
    expect(isPrizePoolUnset('')).toBe(true);
    expect(isPrizePoolUnset('   ')).toBe(true);
    expect(isPrizePoolUnset({})).toBe(true);
    expect(isPrizePoolUnset({ amount: null })).toBe(true);
    expect(isPrizePoolUnset({ amount: '' })).toBe(true);
    expect(isPrizePoolUnset({ prizePool: '  ' })).toBe(true);
    expect(isPrizePoolUnset(0)).toBe(true);
    expect(isPrizePoolUnset({ amount: '100.00' })).toBe(false);
    expect(isPrizePoolUnset('250.50')).toBe(false);
  });

  it('blank prize pool cannot start — typed academy.prize_pool_unset', () => {
    const d = decidePrizePoolStart(null);
    expect(d.status).toBe('refuse');
    expect(d.code).toBe(PRIZE_POOL_UNSET_CODE);
    expect(d.reason).toBe('unset');
    expect(d.inventedIfc).toBe(false);
    expect(d.ledgerRecipeReady).toBe(false);
    expect(isPrizePoolUnsetRefuse(d)).toBe(true);
    expect(d.message).toMatch(/unset/);
    expect(JSON.stringify(d)).not.toMatch(/"amount"/);
  });

  it('present amount still refuses invent IFC (Class M) — never pays', () => {
    const d = decidePrizePoolStart({ amount: '1000.00' });
    expect(d.status).toBe('refuse');
    expect(d.code).toBe(PRIZE_REFUSE_CODE);
    expect(d.reason).toBe('class_m');
    expect(d.inventedIfc).toBe(false);
    expect(isPrizePoolUnsetRefuse(d)).toBe(false);
  });

  it('assertMayStartPrizeSeason throws PrizePoolRefuseError without invent decimals', () => {
    expect(() => assertMayStartPrizeSeason(undefined)).toThrow(PrizePoolRefuseError);
    try {
      assertMayStartPrizeSeason('');
    } catch (err) {
      expect(err).toBeInstanceOf(PrizePoolRefuseError);
      const e = err as PrizePoolRefuseError;
      expect(e.code).toBe(PRIZE_POOL_UNSET_CODE);
      expect(e.reason).toBe('unset');
      expect(e.residual).toBe(PRIZE_POOL_UNSET_RESIDUAL);
      expect(prizePoolUnsetResidualIsHonest(e.residual)).toBe(true);
      expect(JSON.stringify(e)).not.toMatch(/\d+\.\d+/);
    }
    try {
      assertMayStartPrizeSeason({ amount: '50.00' });
    } catch (err) {
      const e = err as PrizePoolRefuseError;
      expect(e.code).toBe(PRIZE_REFUSE_CODE);
      expect(e.reason).toBe('class_m');
      expect(e.residual).toBe(PRIZE_POOL_CLASS_M_RESIDUAL);
    }
  });

  it('refuseUnsetPrizePoolStart is typed unset', () => {
    expect(() => refuseUnsetPrizePoolStart()).toThrow(PrizePoolRefuseError);
  });

  it('tryRefuse + export line carry reason,code only', () => {
    const unset = tryRefusePrizePoolStart(null);
    expect(prizePoolStartRefuseExportHeader()).toBe('reason,code');
    expect(prizePoolStartRefuseExportLine(unset)).toBe(`unset,${PRIZE_POOL_UNSET_CODE}`);
    const set = tryRefusePrizePoolStart('10');
    expect(prizePoolStartRefuseExportLine(set)).toBe(`class_m,${PRIZE_REFUSE_CODE}`);
  });
});

/**
 * Pin: start/fund stay refuse-closed for unset pools. Fails if the typed
 * refuse is removed or a default IFC pool is invented (Class M amounts stay
 * owner-side — this slice never fills them in).
 */
describe('pin: tournament start/fund refuse unset prize pools (no invent IFC)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prize-refuse.ts'), 'utf8');

  it('source still pins academy.prize_pool_unset and never returns ok', () => {
    expect(src).toContain("export const PRIZE_POOL_UNSET_CODE = 'academy.prize_pool_unset'");
    expect(src).toContain('export function decidePrizePoolStart');
    expect(src).toContain('export function refuseFundPrizePool');
    expect(src).toContain('export function assertMayStartPrizeSeason');
    expect(src).toMatch(/code:\s*PRIZE_POOL_UNSET_CODE/);
    expect(src).not.toMatch(/status:\s*['"]ok['"]/);
    expect(src).not.toMatch(/\bDEFAULT_(?:PRIZE|POOL|IFC)/);
    expect(src).not.toMatch(/inventedIfc:\s*true/);
    expect(src).toMatch(/inventedIfc:\s*false/);
  });

  it('start refuses when prize pool is unset — never invents a default pool', () => {
    for (const unset of [null, undefined, '', '   ', {}, { amount: null }, { amount: '' }]) {
      const d = decidePrizePoolStart(unset);
      expect(d.status).toBe('refuse');
      expect(d.code).toBe(PRIZE_POOL_UNSET_CODE);
      expect(d.reason).toBe('unset');
      expect(d.inventedIfc).toBe(false);
      expect(d.ledgerRecipeReady).toBe(false);
      expect(d).not.toHaveProperty('amount');
      expect(d).not.toHaveProperty('prizePool');
      expect(JSON.stringify(d)).not.toMatch(/"amount"\s*:/);
      expect(() => assertMayStartPrizeSeason(unset)).toThrow(PrizePoolRefuseError);
    }
  });

  it('fund refuses when prize pool is unset — no invented IFC credit', () => {
    const d = refuseFundPrizePool();
    expect(d.status).toBe('refuse');
    expect(d.code).toBe(PRIZE_REFUSE_CODE);
    expect(d.kind).toBe('fund_pool');
    expect(d.academyHoldsPrizeBalance).toBe(false);
    expect(d.ledgerRecipeReady).toBe(false);
    expect(d).not.toHaveProperty('amount');
    expect(JSON.stringify(d)).not.toMatch(/\d+\.\d+/);
  });
});
