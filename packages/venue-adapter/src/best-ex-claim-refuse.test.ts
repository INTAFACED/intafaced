import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BEST_EX_CLAIM_UNSET, copyClaimsBestEx, describeBestExClaimRefuse, refuseBestExClaim } from './best-ex-claim-refuse.js';

const UNSET_DETAIL = 'owner best-ex law is unset — refusing rather than claiming best execution';
const here = dirname(fileURLToPath(import.meta.url));

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

describe('live ranker is not a best-ex stamp', () => {
  it('explainRoute / execution report source do not claim best-ex or best price', () => {
    const router = readFileSync(join(here, 'router.ts'), 'utf8');
    const report = readFileSync(join(here, 'execution-report.ts'), 'utf8');
    const explainFn = router.slice(router.indexOf('export function explainRoute'));
    expect(copyClaimsBestEx(explainFn)).toBe(false);
    expect(copyClaimsBestEx(report)).toBe(false);
    expect(explainFn.toLowerCase()).not.toMatch(/we found the best price/);
    expect(report.toLowerCase()).not.toMatch(/best[- ]?execution/);
  });
});

describe('package export seal', () => {
  it('index re-exports best-ex-claim-refuse', () => {
    const pkgIndex = readFileSync(join(here, 'index.ts'), 'utf8');
    expect(pkgIndex).toMatch(/best-ex-claim-refuse/);
  });
});
