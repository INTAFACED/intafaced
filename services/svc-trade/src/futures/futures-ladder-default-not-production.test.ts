/**
 * Unit card — production ladder module does not ship invented D3 rungs
 * 1. Promise: maintenance-ladder.ts has no DEFAULT_FUTURES_LADDER_POLICY table
 * 2. Break: export const DEFAULT_FUTURES_LADDER_POLICY with placeholder tiers
 * 3. Done bar: constant lives only in ladder-policy.test-harness.ts; live jobs still omit policy
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/maintenance-ladder.ts
 * 6. RED: export const DEFAULT_FUTURES_LADDER_POLICY
 * 7. Collision: none — no open svc-trade PRs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const production = readFileSync(join(here, 'maintenance-ladder.ts'), 'utf8');
const harness = readFileSync(join(here, 'ladder-policy.test-harness.ts'), 'utf8');
const jobsHost = readFileSync(join(here, '..', 'index.ts'), 'utf8');

describe('production ladder module does not ship invented D3 rungs', () => {
  it('does not export DEFAULT_FUTURES_LADDER_POLICY', () => {
    expect(production).not.toMatch(/DEFAULT_FUTURES_LADDER_POLICY/);
  });

  it('does not embed the placeholder depth-tier table', () => {
    expect(production).not.toMatch(/uptoDepthBps:\s*500,\s*maintenanceBps:\s*50/);
  });

  it('keeps the placeholder only in the test harness', () => {
    expect(harness).toMatch(/export const DEFAULT_FUTURES_LADDER_POLICY/);
    expect(harness).toMatch(/Test-only ladder numbers/);
  });

  it('live host passes no ladder but the owner\u2019s published setting', () => {
    expect(jobsHost).not.toMatch(
      /startFuturesJobs\([\s\S]{0,1500}ladderPolicy:(?!\s*ownerLadderPolicy\(env\.TRADE_FUTURES_LADDER_POLICY\))/,
    );
  });
});
