/**
 * Unit card — loan quote asset is owner-published; blank refuses, never USDT
 *
 * 1. Promise: LOAN_QUOTE_ASSET_ID from host `.env` reaches the container.
 *    Unset / blank refuses boot. Never invent USDT.
 * 2. Break: compose `:-USDT` or env.ts `.default('USDT')` looks published
 *    when the operator never set a mark asset.
 * 3. Done bar: docker-compose.apps.yml svc-bank has
 *    LOAN_QUOTE_ASSET_ID: ${LOAN_QUOTE_ASSET_ID:-}
 *    LOAN_SWEEP_BATCH_SIZE: ${LOAN_SWEEP_BATCH_SIZE:-}
 *    env.ts is z.string().trim().min(1) with no USDT default
 *    and LOAN_RISK_SWEEP_ENABLED remains off/false
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-bank block only), env.ts
 * 6. RED: pin fails if quote default is USDT, compose bakes USDT, sweep batch
 *    default is invented, or sweep is flipped on
 * 7. Collision: jwt/cards/loans/ramp/jobs/earn/transfer-batch compose pins —
 *    this pin does not restamp JWT_*, TRANSFER_BATCH_SIZE, LOAN_ACCRUAL_ENABLED,
 *    BANK_LOANS_ENABLED, BANK_CARDS_ENABLED, BANK_RAMP_MODE, BANK_CARD_ISSUER,
 *    TRADE_URL, or INTEREST_ACCRUAL; does not turn LOAN_RISK_SWEEP on
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);

function bankServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-bank');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const LINE = /^\s+LOAN_QUOTE_ASSET_ID:\s*\$\{LOAN_QUOTE_ASSET_ID:-\}\s*$/gm;
const SWEEP_BATCH = /^\s+LOAN_SWEEP_BATCH_SIZE:\s*\$\{LOAN_SWEEP_BATCH_SIZE:-\}\s*$/gm;
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

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: SECRET,
  LOAN_QUOTE_ASSET_ID: 'X',
  TRANSFER_BATCH_SIZE: '200',
  LOAN_SWEEP_BATCH_SIZE: '500',
};

/**
 * Load production env.ts the way the process does.
 *
 * `vi.resetModules` + explicit clears are load-bearing: env.ts calls
 * `loadEnv(process.env)` at import. A forked Zod slice would stay green if
 * production still defaulted USDT.
 */
async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOAN_QUOTE_ASSET_ID', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose LOAN_QUOTE_ASSET_ID for svc-bank', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-bank/src/env.ts'), 'utf8');
  const block = bankServiceBlock(compose);

  it('env.ts refuses blank quote asset — no USDT default; sweep batch not invented', () => {
    expect(envTs).not.toMatch(/LOAN_QUOTE_ASSET_ID:\s*z\.string\(\)\.default\('USDT'\)/);
    expect(envTs).toMatch(/LOAN_QUOTE_ASSET_ID:\s*z\.string\(\)\.trim\(\)\.min\(1\)/);
    expect(envTs).not.toMatch(/LOAN_SWEEP_BATCH_SIZE:[\s\S]{0,400}\.default\(500\)/);
  });

  it('compose svc-bank block is the unique home of both keys; quote is empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-bank/);
    expect(block.match(LINE)).toHaveLength(1);
    expect(block.match(SWEEP_BATCH)).toHaveLength(1);
    expect(block).not.toMatch(/LOAN_QUOTE_ASSET_ID:\s*\$\{LOAN_QUOTE_ASSET_ID:-USDT\}/);
    expect(countAssignments(block, 'LOAN_QUOTE_ASSET_ID')).toBe(1);
    expect(countAssignments(block, 'LOAN_SWEEP_BATCH_SIZE')).toBe(1);

    const quoteHits = compose.match(/^\s+LOAN_QUOTE_ASSET_ID:/gm) ?? [];
    const sweepHits = compose.match(/^\s+LOAN_SWEEP_BATCH_SIZE:/gm) ?? [];
    expect(quoteHits, 'LOAN_QUOTE_ASSET_ID must appear once (svc-bank only)').toHaveLength(1);
    expect(sweepHits, 'LOAN_SWEEP_BATCH_SIZE must appear once (svc-bank only)').toHaveLength(1);
  });

  it('does not invent APY/LTV/mids, restamp sibling bank compose keys, or turn sweep on', () => {
    expect(block.match(TTL)).toHaveLength(1);
    expect(block.match(ISSUER)).toHaveLength(1);
    expect(block.match(AUDIENCE)).toHaveLength(1);
    expect(block.match(TRANSFER_BATCH)).toHaveLength(1);
    expect(block.match(LOAN_ACCRUAL)).toHaveLength(1);
    expect(block.match(BANK_LOANS)).toHaveLength(1);
    expect(block.match(BANK_CARDS)).toHaveLength(1);
    expect(block.match(BANK_RAMP)).toHaveLength(1);
    expect(block.match(CARD_ISSUER)).toHaveLength(1);
    expect(block.match(TRADE_URL)).toHaveLength(1);
    expect(block.match(INTEREST_ACCRUAL)).toHaveLength(1);
    expect(block).toMatch(/LOAN_RISK_SWEEP_ENABLED:\s*\$\{LOAN_RISK_SWEEP_ENABLED:-false\}/);
    expect(block).not.toMatch(/LOAN_RISK_SWEEP_ENABLED:\s*\$\{LOAN_RISK_SWEEP_ENABLED:-true\}/);
    expect(block).not.toMatch(/LOAN_LTV|MAX_LTV|USDT_MID|LOAN_APY/i);
  });
});

describe('svc-bank LOAN_QUOTE_ASSET_ID refuse-closed', () => {
  it('env.ts source keeps the refuse-closed shape production loadEnv parses', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/LOAN_QUOTE_ASSET_ID:\s*z\.string\(\)\.default\('USDT'\)/);
    expect(envTs).toMatch(/LOAN_QUOTE_ASSET_ID:\s*z\.string\(\)\.trim\(\)\.min\(1\)/);
  });

  it('unset LOAN_QUOTE_ASSET_ID refuses (no invent USDT)', async () => {
    await expect(loadWith({ LOAN_QUOTE_ASSET_ID: undefined })).rejects.toThrow(/LOAN_QUOTE_ASSET_ID/);
  });

  it('blank LOAN_QUOTE_ASSET_ID refuses', async () => {
    await expect(loadWith({ LOAN_QUOTE_ASSET_ID: '' })).rejects.toThrow(/LOAN_QUOTE_ASSET_ID/);
  });

  it('whitespace LOAN_QUOTE_ASSET_ID refuses', async () => {
    await expect(loadWith({ LOAN_QUOTE_ASSET_ID: '   ' })).rejects.toThrow(/LOAN_QUOTE_ASSET_ID/);
  });

  it('explicit owner pin is accepted (not invented)', async () => {
    const parsed = await loadWith({ LOAN_QUOTE_ASSET_ID: 'EURC' });
    expect(parsed.LOAN_QUOTE_ASSET_ID).toBe('EURC');
  });
});
