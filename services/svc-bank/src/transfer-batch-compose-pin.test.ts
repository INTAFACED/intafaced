/**
 * Unit card — compose passes TRANSFER_BATCH_SIZE empty into svc-bank
 *
 * 1. Promise: host `.env` can pin scheduled-transfer batch size; compose does
 *    not invent 200. Unset / empty stays unpublished and env.ts refuses boot.
 * 2. Break: compose `:-200` (or omitting the key) makes a blank host env look
 *    published as a job batch ceiling nobody chose.
 * 3. Done bar: docker-compose.apps.yml svc-bank has
 *    TRANSFER_BATCH_SIZE: ${TRANSFER_BATCH_SIZE:-}
 *    env.ts preprocess blank → undefined, coerce int min 1 max 10_000, no `.default(200)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-bank block only) + env.ts
 * 6. RED: pin fails if cadence default is 200, compose bakes 200, or sibling
 *    bank keys are restamped
 * 7. Collision: jobs/earn/loan compose pins — this pin only names TRANSFER_BATCH_SIZE
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NAME = 'TRANSFER_BATCH_SIZE';
const EMPTY_PASS = `${NAME}: \${${NAME}:-}`;

function bankServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-bank');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose TRANSFER_BATCH_SIZE for svc-bank', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-bank/src/env.ts'), 'utf8');
  const block = bankServiceBlock(compose);

  it('env.ts refuses blank transfer batch — no 200 default', () => {
    expect(envTs).not.toMatch(/TRANSFER_BATCH_SIZE:[\s\S]{0,400}\.default\(200\)/);
    expect(envTs).toMatch(
      /TRANSFER_BATCH_SIZE:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(10_000\),\s*\)/,
    );
  });

  it('svc-bank compose line is empty pass-through — no invented 200', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-bank/);
    expect(block, `${NAME} missing empty pass-through`).toContain(EMPTY_PASS);
    expect(block).toMatch(new RegExp(`${NAME}:\\s*\\$\\{${NAME}:-\\}`));
    expect(block).not.toMatch(new RegExp(`${NAME}:\\s*\\$\\{${NAME}:-200\\}`));
    expect(countAssignments(block, NAME), `${NAME} must appear once on svc-bank`).toBe(1);
    expect(compose.match(/^\s+TRANSFER_BATCH_SIZE:/gm) ?? []).toHaveLength(1);
  });

  it('does not invent APY/LTV/mids or restamp sibling bank compose keys', () => {
    expect(block).not.toMatch(/LOAN_RISK_SWEEP_ENABLED:\s*\$\{LOAN_RISK_SWEEP_ENABLED:-true\}/);
    expect(block).not.toMatch(/LOAN_LTV|MAX_LTV|USDT_MID|LOAN_APY/i);
  });
});
