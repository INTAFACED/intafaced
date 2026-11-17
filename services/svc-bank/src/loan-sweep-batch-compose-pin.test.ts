/**
 * Unit card — compose passes LOAN_SWEEP_BATCH_SIZE empty into svc-bank
 *
 * 1. Promise: host `.env` can pin loan-sweep batch size; compose does not
 *    invent 500. Unset / empty stays unpublished and env.ts refuses boot.
 * 2. Break: compose `:-500` (or omitting the key) makes a blank host env look
 *    published as a job batch ceiling nobody chose.
 * 3. Done bar: docker-compose.apps.yml svc-bank has
 *    LOAN_SWEEP_BATCH_SIZE: ${LOAN_SWEEP_BATCH_SIZE:-}
 *    env.ts preprocess blank → undefined, coerce int min 1 max 10_000, no `.default(500)`
 *    LOAN_RISK_SWEEP_ENABLED remains off/false
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-bank block only) + env.ts
 * 6. RED: pin fails if cadence default is 500, compose bakes 500, or sweep is
 *    flipped on
 * 7. Collision: jwt/cards/loans/ramp/jobs/earn/transfer-batch compose pins —
 *    this pin does not restamp TRANSFER_BATCH_SIZE, JWT_*, BANK_LOANS_ENABLED,
 *    BANK_CARDS_ENABLED, BANK_RAMP_MODE, BANK_CARD_ISSUER, TRADE_URL, or
 *    INTEREST_ACCRUAL; does not turn LOAN_RISK_SWEEP on
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NAME = 'LOAN_SWEEP_BATCH_SIZE';
const EMPTY_PASS = `${NAME}: \${${NAME}:-}`;

function bankServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-bank');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose LOAN_SWEEP_BATCH_SIZE for svc-bank', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-bank/src/env.ts'), 'utf8');
  const block = bankServiceBlock(compose);

  it('env.ts refuses blank sweep batch — no 500 default; sweep stays off', () => {
    expect(envTs).not.toMatch(/LOAN_SWEEP_BATCH_SIZE:[\s\S]{0,400}\.default\(500\)/);
    expect(envTs).toMatch(
      /LOAN_SWEEP_BATCH_SIZE:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(10_000\),\s*\)/,
    );
  });

  it('svc-bank compose line is empty pass-through — no invented 500', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-bank/);
    expect(block, `${NAME} missing empty pass-through`).toContain(EMPTY_PASS);
    expect(block).toMatch(new RegExp(`${NAME}:\\s*\\$\\{${NAME}:-\\}`));
    expect(block).not.toMatch(new RegExp(`${NAME}:\\s*\\$\\{${NAME}:-500\\}`));
    expect(countAssignments(block, NAME), `${NAME} must appear once on svc-bank`).toBe(1);
    expect(compose.match(/^\s+LOAN_SWEEP_BATCH_SIZE:/gm) ?? []).toHaveLength(1);
  });

  it('does not invent APY/LTV/mids or turn sweep on', () => {
    expect(block).toMatch(/LOAN_RISK_SWEEP_ENABLED:\s*\$\{LOAN_RISK_SWEEP_ENABLED:-false\}/);
    expect(block).not.toMatch(/LOAN_RISK_SWEEP_ENABLED:\s*\$\{LOAN_RISK_SWEEP_ENABLED:-true\}/);
    expect(block).not.toMatch(/LOAN_LTV|MAX_LTV|USDT_MID|LOAN_APY/i);
  });
});
