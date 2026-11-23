/**
 * Unit card — compose stack passes access-token TTL / issuer / audience into svc-bank
 *
 * 1. Promise: JWT_ACCESS_TTL_SECONDS, JWT_ISSUER, and JWT_AUDIENCE from host
 *    `.env` reach the container (authEnvSchema already defaults 900 /
 *    intafaced / intafaced.api).
 * 2. Break: compose booted bank with cards/loans/ramp/transfer-batch keys but
 *    no ttl / iss / aud → host pin of token life is a no-op and the process
 *    keeps schema-only defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-bank has
 *    JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}
 *    JWT_ISSUER: ${JWT_ISSUER:-intafaced}
 *    JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-bank block only)
 * 6. RED: pin fails if a unique key drops inside the bank block, defaults
 *    drift, JWT_ACCESS_SECRET is invented, or APY/LTV/mids appear
 * 7. Collision: cards/loans/ramp/jobs/earn/transfer-batch compose pins — this
 *    pin does not restamp TRANSFER_BATCH_SIZE, LOAN_ACCRUAL_ENABLED,
 *    BANK_LOANS_ENABLED, BANK_CARDS_ENABLED, BANK_RAMP_MODE, BANK_CARD_ISSUER,
 *    TRADE_URL, or INTEREST_ACCRUAL
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

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;
const TRANSFER_BATCH = /^\s+TRANSFER_BATCH_SIZE:\s*\$\{TRANSFER_BATCH_SIZE:-\}\s*$/gm;
const LOAN_ACCRUAL = /^\s+LOAN_ACCRUAL_ENABLED:\s*\$\{LOAN_ACCRUAL_ENABLED:-true\}\s*$/gm;
const BANK_LOANS = /^\s+BANK_LOANS_ENABLED:\s*\$\{BANK_LOANS_ENABLED:-true\}\s*$/gm;
const BANK_CARDS = /^\s+BANK_CARDS_ENABLED:\s*\$\{BANK_CARDS_ENABLED:-true\}\s*$/gm;
const BANK_RAMP = /^\s+BANK_RAMP_MODE:\s*\$\{BANK_RAMP_MODE:-none\}\s*$/gm;
const CARD_ISSUER = /^\s+BANK_CARD_ISSUER:\s*\$\{BANK_CARD_ISSUER:-none\}\s*$/gm;
const TRADE_URL = /^\s+TRADE_URL:\s*http:\/\/svc-trade:4004\s*$/gm;
const INTEREST_ACCRUAL = /^\s+INTEREST_ACCRUAL_ENABLED:\s*\$\{INTEREST_ACCRUAL_ENABLED:-true\}\s*$/gm;

describe('compose access-token TTL issuer audience for svc-bank', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const authEnv = readFileSync(join(ROOT, 'packages/config/src/env.ts'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-bank/src/env.ts'), 'utf8');
  const block = bankServiceBlock(compose);

  it('env.ts still merges edgeEnvSchema; authEnvSchema defaults match identity', () => {
    expect(envTs).toMatch(/\.merge\(edgeEnvSchema\)/);
    expect(authEnv).toMatch(/JWT_ACCESS_TTL_SECONDS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(60\)\.max\(3600\)\.default\(900\)/);
    expect(authEnv).toMatch(/JWT_ISSUER:\s*z\.string\(\)\.default\('intafaced'\)/);
    expect(authEnv).toMatch(/JWT_AUDIENCE:\s*z\.string\(\)\.default\('intafaced\.api'\)/);
  });

  it('compose svc-bank block passes unique keys once; defaults 900 / intafaced / intafaced.api', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-bank/);
    expect(block.match(TTL)).toHaveLength(1);
    expect(block.match(ISSUER)).toHaveLength(1);
    expect(block.match(AUDIENCE)).toHaveLength(1);
    expect(countAssignments(block, 'JWT_ACCESS_TTL_SECONDS')).toBe(1);
    expect(countAssignments(block, 'JWT_ISSUER')).toBe(1);
    expect(countAssignments(block, 'JWT_AUDIENCE')).toBe(1);
  });

  it('does not restamp JWT_ACCESS_SECRET, cards/loans/ramp/transfer-batch, or invent APY/LTV/mids', () => {
    expect(block).not.toMatch(/JWT_ACCESS_SECRET:/);
    expect(block.match(TRANSFER_BATCH)).toHaveLength(1);
    expect(block.match(LOAN_ACCRUAL)).toHaveLength(1);
    expect(block.match(BANK_LOANS)).toHaveLength(1);
    expect(block.match(BANK_CARDS)).toHaveLength(1);
    expect(block.match(BANK_RAMP)).toHaveLength(1);
    expect(block.match(CARD_ISSUER)).toHaveLength(1);
    expect(block.match(TRADE_URL)).toHaveLength(1);
    expect(block.match(INTEREST_ACCRUAL)).toHaveLength(1);
    expect(block).not.toMatch(/LOAN_LTV|MAX_LTV|USDT_MID|LOAN_APY|EARN_APY/i);
  });
});
