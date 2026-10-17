import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TokenError, assertStakesListLimit } from './token-service.js';
import { userCopy } from './user-copy.js';

/**
 * listStakes page size is refuse-closed when unset.
 *
 * listStakes SELECTed token.stakes with no LIMIT, so omit dumped every row.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('listStakes limit unset refuse', () => {
  it('assertStakesListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertStakesListLimit(undefined)).toThrow(TokenError);
    expect(() => assertStakesListLimit(Number.NaN)).toThrow(TokenError);
    expect(() => assertStakesListLimit(0)).toThrow(TokenError);
    try {
      assertStakesListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TokenError);
      expect((e as TokenError).code).toBe('token.stakes_list_limit_unset');
      expect((e as TokenError).message).toBe('Stake list limit is unset');
      expect((e as TokenError).message).not.toMatch(/50-row|default 50/i);
      expect(userCopy((e as TokenError).code)).toBe('The stake list size is not set.');
      expect(userCopy((e as TokenError).code)).not.toMatch(/50/);
    }
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertStakesListLimit(50)).toBe(50);
    expect(assertStakesListLimit(1)).toBe(1);
    expect(assertStakesListLimit(200)).toBe(200);
    expect(assertStakesListLimit(201)).toBe(200);
  });

  it('listStakes SELECT carries LIMIT and does not default to 50', () => {
    const src = readFileSync(join(ROOT, 'services/svc-token/src/token-service.ts'), 'utf8');
    const start = src.indexOf('async listStakes(');
    const end = src.indexOf('async feeDiscountSchedule(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertStakesListLimit');
    expect(fn).toMatch(/LIMIT \$\{page\}/);
    expect(fn).not.toMatch(/input\.limit \?\? 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });

  it('router does not invent 50 when listStakes omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-token/src/router.ts'), 'utf8');
    const start = src.indexOf('listStakes:');
    const end = src.indexOf('mintEpoch:', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('token.listStakes(userId, input.status, input.limit)');
    expect(fn).not.toMatch(/input\.limit \?\? 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });

  it('yield job active-stake work set stays unbounded (not this mill)', () => {
    const src = readFileSync(join(ROOT, 'services/svc-token/src/token-service.ts'), 'utf8');
    expect(src).toMatch(/SELECT id, user_id, amount, tier, multiplier_bps FROM token\.stakes WHERE status = 'active' ORDER BY id ASC/);
  });
});
