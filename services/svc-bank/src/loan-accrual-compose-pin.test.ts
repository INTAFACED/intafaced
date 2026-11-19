/**
 * Unit card — compose stack passes loan interest-accrual kill into svc-bank
 *
 * 1. Promise: LOAN_ACCRUAL_ENABLED from host `.env` reaches the container
 *    (env.ts already declares it, default true).
 * 2. Break: compose booted bank without the name → operator stop is a no-op
 *    and halting earn payouts is the only compose-reachable interest kill.
 * 3. Done bar: docker-compose.apps.yml svc-bank has
 *    LOAN_ACCRUAL_ENABLED: ${LOAN_ACCRUAL_ENABLED:-true}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-bank block only)
 * 6. RED: pin fails if the key drops off, appears twice, or default is not true
 * 7. Collision: earn/loans/cards compose pins — this pin only names loan accrual
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function bankServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-bank');
}

describe('compose loan interest-accrual kill for svc-bank', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-bank/src/env.ts'), 'utf8');
  const block = bankServiceBlock(compose);

  it('env.ts still declares LOAN_ACCRUAL_ENABLED default true', () => {
    expect(envTs).toMatch(/LOAN_ACCRUAL_ENABLED:\s*z/);
    const slice = envTs.slice(envTs.indexOf('LOAN_ACCRUAL_ENABLED:'));
    expect(slice.slice(0, 400)).toMatch(/\.default\(\s*true\s*\)/);
  });

  it('compose svc-bank block is the unique home of the key, default true', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-bank/);
    expect(block).toMatch(/LOAN_ACCRUAL_ENABLED:\s*\$\{LOAN_ACCRUAL_ENABLED:-true\}/);

    const hits = compose.match(/^\s+LOAN_ACCRUAL_ENABLED:/gm) ?? [];
    expect(hits, 'LOAN_ACCRUAL_ENABLED must appear once (svc-bank only)').toHaveLength(1);
  });

  it('does not invent LTV, USDT mids, or APY on the compose block', () => {
    expect(block).not.toMatch(/LOAN_LTV|MAX_LTV|USDT_MID|LOAN_APY/i);
    expect(block).not.toMatch(/LOAN_ACCRUAL_ENABLED:\s*\$\{LOAN_ACCRUAL_ENABLED:-false\}/);
    expect(block).not.toMatch(/LOAN_RISK_SWEEP_ENABLED:\s*\$\{LOAN_RISK_SWEEP_ENABLED:-true\}/);
  });
});
