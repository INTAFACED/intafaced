import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { BEST_EX_CLAIM_UNSET, copyClaimsBestEx, describeBestExClaimRefuse, refuseBestExClaim } from './best-ex-claim-refuse.js';
import { buildExecutionReport } from './execution-report.js';
import * as pkg from './index.js';
import { explainRoute, planRoute } from './router.js';
import type { LiquiditySource } from './source.js';

const UNSET_DETAIL = 'owner best-ex law is unset — refusing rather than claiming best execution';

function expectRefused(verdict: ReturnType<typeof refuseBestExClaim>): void {
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  expect(verdict.reason).toBe('best_ex_unset');
  expect(verdict.code).toBe(BEST_EX_CLAIM_UNSET);
  expect(verdict.detail).toBe(UNSET_DETAIL);
}

describe('refuseBestExClaim — Q/R named refuse', () => {
  it('ranking without a claim is idle — not best-ex', () => {
    expect(refuseBestExClaim()).toEqual({ ok: true, claimed: false });
    expect(refuseBestExClaim({ claim: false })).toEqual({ ok: true, claimed: false });
  });

  it.each([
    ['claim flag', { claim: true }],
    ['kind best-ex', { kind: 'best-ex' }],
    ['kind best_execution', { kind: 'best_execution' }],
    ['kind sor', { kind: 'sor' }],
    ['kind smart-route', { kind: 'smart-route' }],
    ['kind we-found-the-best-price', { kind: 'we-found-the-best-price' }],
    ['copy best execution', { copy: 'This is best execution.' }],
    ['copy we found the best price', { copy: 'We found the best price.' }],
    ['copy smart-route', { copy: 'smart-route across venues' }],
  ] as const)('%s without owner law refuses', (_label, input) => {
    expectRefused(refuseBestExClaim(input));
  });

  it.each([undefined, null, false, '', '  ', 'false', '0', 'off', 'unset', 'invented'] as const)(
    'owner law %j is unset — refuse the claim',
    (law) => {
      expectRefused(refuseBestExClaim({ claim: true, ownerBestExLaw: law }));
    },
  );

  it('boolean true is not a named owner law and does not seal the claim', () => {
    expect(refuseBestExClaim({ claim: true, ownerBestExLaw: true })).toEqual({
      ok: false,
      reason: 'best_ex_unset',
      code: BEST_EX_CLAIM_UNSET,
      detail: UNSET_DETAIL,
    });
  });

  it('named owner law allows the claim through this gate only', () => {
    const sealed = refuseBestExClaim({
      claim: true,
      ownerBestExLaw: 'socket.external-best-execution-law',
    });
    expect(sealed).toEqual({
      ok: true,
      claimed: true,
      ownerBestExLaw: 'socket.external-best-execution-law',
    });
  });

  it('honest negation is not a claim', () => {
    expect(refuseBestExClaim({ copy: 'not a best-execution claim' })).toEqual({ ok: true, claimed: false });
    expect(refuseBestExClaim({ copy: 'never smart-route without owner law' })).toEqual({
      ok: true,
      claimed: false,
    });
    expect(copyClaimsBestEx(UNSET_DETAIL)).toBe(false);
  });
});

describe('describeBestExClaimRefuse — honesty board', () => {
  it('states ranking is not best-ex and does not invent a best price', () => {
    const board = describeBestExClaimRefuse();
    expect(board.rankingIsNotBestExClaim).toBe(true);
    expect(board.smartRouteWithoutOwnerLaw).toBe(false);
    expect(board.inventsBestPrice).toBe(false);
    expect(board.unsetCode).toBe('venue.best_ex_claim_unset');
  });
});

const AT = new Date('2026-08-12T00:00:00.000Z');

function venue(id: string, price: string, amount: string): LiquiditySource {
  return {
    id,
    kind: 'external-cex',
    capabilities: ['quote'],
    health: () => ({ healthy: true, latencyMs: 10, lastUpdate: AT }),
    markets: async () => [],
    quote: async (req) => ({
      venueId: id,
      symbol: req.symbol,
      side: req.side,
      amount: parseAmount(amount),
      price: parseAmount(price),
      feeBps: 10,
      expiresAt: new Date('2026-08-12T01:00:00.000Z'),
    }),
    orderBook: async () => ({}) as never,
    submit: async () => ({}) as never,
  };
}

describe('live ranker is not a best-ex stamp', () => {
  it('explainRoute and the execution report never claim best-ex or a best price, filled, split, short or empty', async () => {
    const request = (amount: string) => ({ symbol: 'BTC/USDT', side: 'buy' as const, amount: parseAmount(amount) });
    const plans = [
      await planRoute(request('1'), [venue('a', '30000', '1')], { now: AT }),
      await planRoute(request('2'), [venue('a', '30000', '1'), venue('b', '30010', '1')], { now: AT }),
      await planRoute(request('10'), [venue('a', '30000', '1')], { now: AT }),
      await planRoute(request('1'), [], { now: AT }),
    ];
    expect(plans.map((p) => p.legs.length)).toEqual([1, 2, 1, 0]);
    for (const plan of plans) {
      const explained = explainRoute(plan);
      const report = JSON.stringify(buildExecutionReport(plan));
      expect(copyClaimsBestEx(explained), explained).toBe(false);
      expect(copyClaimsBestEx(report), report).toBe(false);
      expect(explained.toLowerCase()).not.toMatch(/we found the best price|best[- ]?execution/);
      expect(report.toLowerCase()).not.toMatch(/best[- ]?execution/);
    }
  });
});

describe('package export seal', () => {
  it('the package entry exports the best-ex refuse door itself', () => {
    expect(pkg.refuseBestExClaim).toBe(refuseBestExClaim);
    expect(pkg.copyClaimsBestEx).toBe(copyClaimsBestEx);
    expect(pkg.describeBestExClaimRefuse).toBe(describeBestExClaimRefuse);
    expect(pkg.BEST_EX_CLAIM_UNSET).toBe(BEST_EX_CLAIM_UNSET);
    expectRefused(pkg.refuseBestExClaim({ claim: true }));
  });
});
