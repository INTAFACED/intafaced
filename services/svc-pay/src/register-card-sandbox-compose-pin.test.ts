/**
 * Unit card — compose stack passes PAY_REGISTER_CARD_SANDBOX + optional
 * live-crypto env into svc-pay
 *
 * 1. Promise: host `.env` can pin card-sandbox registration and optional
 *    live-crypto keys; env.ts already types them as optional (empty string
 *    is invalid for enum / url / min / hex).
 * 2. Break: compose booted pay without the names → host pin is a no-op;
 *    `${VAR:-}` interpolates empty string, which fails the schemas.
 * 3. Done bar: docker-compose.apps.yml svc-pay has key-no-value
 *    PAY_REGISTER_CARD_SANDBOX:
 *    PAY_CRYPTO_RPC_URL:
 *    PAY_CRYPTO_CHAIN_ID:
 *    PAY_CRYPTO_DEPOSIT_MNEMONIC:
 *    PAY_CRYPTO_SIGNER:
 *    PAY_CRYPTO_ASSETS:
 *    (key, no value; unset omits). Do not bake true/false or `${VAR:-}`.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-pay block only)
 * 6. RED: pin fails if a unique key drops, is duplicated, uses `:-`,
 *    or bakes true/false / fee bps / checkout rails / JWT
 * 7. Collision: checkout / watcher / link / operator-credit compose pins —
 *    this pin does not restamp JWT_*, PAY_OPERATOR_CREDIT_RAILS,
 *    PAY_ALLOW_SANDBOX_RAILS, PAY_LINK_*, PAY_WEBHOOK_*, PAY_MIN_CONFIRMATIONS,
 *    watcher keys, IDENTITY_URL, LEDGER_URL
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function payServiceBlock(source: string): string {
  const match = source.match(/^  svc-pay:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-pay service block missing from docker-compose.apps.yml');
  return match[0];
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

function keyNoValue(name: string): RegExp {
  return new RegExp(`^\\s+${name}:\\s*$`, 'gm');
}

const REGISTER = keyNoValue('PAY_REGISTER_CARD_SANDBOX');
const RPC = keyNoValue('PAY_CRYPTO_RPC_URL');
const CHAIN_ID = keyNoValue('PAY_CRYPTO_CHAIN_ID');
const MNEMONIC = keyNoValue('PAY_CRYPTO_DEPOSIT_MNEMONIC');
const SIGNER = keyNoValue('PAY_CRYPTO_SIGNER');
const ASSETS = keyNoValue('PAY_CRYPTO_ASSETS');
const OPERATOR_CREDIT = /^\s+PAY_OPERATOR_CREDIT_RAILS:\s*\$\{PAY_OPERATOR_CREDIT_RAILS:-\}\s*$/gm;
const SANDBOX_ALLOW = /^\s+PAY_ALLOW_SANDBOX_RAILS:\s*\$\{PAY_ALLOW_SANDBOX_RAILS:-false\}\s*$/gm;
const LINK_DEFAULT = /^\s+PAY_LINK_DEFAULT_TTL_DAYS:\s*\$\{PAY_LINK_DEFAULT_TTL_DAYS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const LINK_MAX = /^\s+PAY_LINK_MAX_TTL_DAYS:\s*\$\{PAY_LINK_MAX_TTL_DAYS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const WEBHOOK_TOLERANCE =
  /^\s+PAY_WEBHOOK_TOLERANCE_SECONDS:\s*\$\{PAY_WEBHOOK_TOLERANCE_SECONDS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const CONFIRMATIONS = /^\s+PAY_MIN_CONFIRMATIONS:\s*\$\{PAY_MIN_CONFIRMATIONS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const WATCHER_ENABLED = /^\s+PAY_CRYPTO_WATCHER_ENABLED:\s*\$\{PAY_CRYPTO_WATCHER_ENABLED:-true\}\s*$/gm;
const WATCHER_INTERVAL = /^\s+PAY_CRYPTO_WATCHER_INTERVAL_MS:\s*\$\{PAY_CRYPTO_WATCHER_INTERVAL_MS:-2000\}\s*$/gm;
const IDENTITY_URL = /^\s+IDENTITY_URL:\s*http:\/\/svc-identity:4002\s*$/gm;
const LEDGER_URL = /^\s+LEDGER_URL:\s*http:\/\/svc-ledger:4001\s*$/gm;

const KEY_NO_VALUE = [
  ['PAY_REGISTER_CARD_SANDBOX', REGISTER],
  ['PAY_CRYPTO_RPC_URL', RPC],
  ['PAY_CRYPTO_CHAIN_ID', CHAIN_ID],
  ['PAY_CRYPTO_DEPOSIT_MNEMONIC', MNEMONIC],
  ['PAY_CRYPTO_SIGNER', SIGNER],
  ['PAY_CRYPTO_ASSETS', ASSETS],
] as const;

describe('compose PAY_REGISTER_CARD_SANDBOX for svc-pay', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-pay/src/env.ts'), 'utf8');
  const block = payServiceBlock(compose);

  it('env.ts still declares optional true|false enum (empty string invalid)', () => {
    expect(envTs).toMatch(/PAY_REGISTER_CARD_SANDBOX:\s*z\.enum\(\['true',\s*'false'\]\)\.optional\(\)/);
  });

  it('env.ts still declares optional live-crypto keys (empty string invalid)', () => {
    expect(envTs).toMatch(/PAY_CRYPTO_RPC_URL:\s*z\.string\(\)\.url\(\)\.optional\(\)/);
    expect(envTs).toMatch(/PAY_CRYPTO_CHAIN_ID:\s*z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.optional\(\)/);
    expect(envTs).toMatch(/PAY_CRYPTO_DEPOSIT_MNEMONIC:\s*z\.string\(\)\.min\(20\)\.optional\(\)/);
    expect(envTs).toMatch(/PAY_CRYPTO_SIGNER:\s*z\.enum\(\['testnet'\]\)\.optional\(\)/);
    expect(envTs).toMatch(/PAY_CRYPTO_ASSETS:\s*z\.string\(\)\.min\(1\)\.optional\(\)/);
  });

  it('compose svc-pay block has each optional key once as key-no-value', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-pay/);
    for (const [name, line] of KEY_NO_VALUE) {
      expect(block.match(line), name).toHaveLength(1);
      expect(countAssignments(block, name), name).toBe(1);
      expect(block).not.toMatch(new RegExp(`${name}:\\s*\\$\\{`));
      expect(block).not.toMatch(new RegExp(`${name}:.*:-`));
    }
    expect(block).not.toMatch(/PAY_REGISTER_CARD_SANDBOX:.*true/);
    expect(block).not.toMatch(/PAY_REGISTER_CARD_SANDBOX:.*false/);
  });

  it('does not invent fee/checkout rails or restamp siblings / JWT', () => {
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*\$\{PAY_DEFAULT_FEE_BPS:-\d+\}/);
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*['"]?\d+/);
    expect(block).not.toMatch(/PAY_CHECKOUT_RAILS:/);
    expect(block).not.toMatch(/^\s+JWT_/m);
    expect(block.match(OPERATOR_CREDIT)).toHaveLength(1);
    expect(block.match(SANDBOX_ALLOW)).toHaveLength(1);
    expect(block.match(LINK_DEFAULT)).toHaveLength(1);
    expect(block.match(LINK_MAX)).toHaveLength(1);
    expect(block.match(WEBHOOK_TOLERANCE)).toHaveLength(1);
    expect(block.match(CONFIRMATIONS)).toHaveLength(1);
    expect(block.match(WATCHER_ENABLED)).toHaveLength(1);
    expect(block.match(WATCHER_INTERVAL)).toHaveLength(1);
    expect(block.match(IDENTITY_URL)).toHaveLength(1);
    expect(block.match(LEDGER_URL)).toHaveLength(1);
  });
});
