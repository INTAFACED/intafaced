/**
 * Unit card — compose stack passes operator-credit rails into svc-pay
 *
 * 1. Promise: PAY_OPERATOR_CREDIT_RAILS from host `.env` reaches the container
 *    (env.ts already declares it). Blank refuses — never `card-sandbox`.
 *    Owner explicit `card-sandbox` is allowed.
 * 2. Break: compose `:-card-sandbox` makes blank look published; a missing
 *    key makes a host pin a no-op and the process keeps a schema default.
 * 3. Done bar: docker-compose.apps.yml svc-pay has
 *    PAY_OPERATOR_CREDIT_RAILS: ${PAY_OPERATOR_CREDIT_RAILS:-}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-pay block only)
 * 6. RED: pin fails if the unique key drops, compose bakes card-sandbox,
 *    env.ts defaults card-sandbox, or PAY_CHECKOUT_RAILS / a baked
 *    PAY_DEFAULT_FEE_BPS magnitude / RPC / mnemonic / hot wallet appear
 * 7. Collision: checkout-compose-flags-pin.test.ts,
 *    checkout-session-cap-compose-pin.test.ts,
 *    crypto-watcher-compose-pin.test.ts,
 *    link-ttl-compose-pin.test.ts, and
 *    register-card-sandbox-compose-pin.test.ts — this pin does not restamp
 *    webhook secrets, watcher, confirmations, checkout TTL/path/sessions,
 *    sandbox-allow, link TTL, risk band, or webhook tolerance
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

const OPERATOR_CREDIT = /^\s+PAY_OPERATOR_CREDIT_RAILS:\s*\$\{PAY_OPERATOR_CREDIT_RAILS:-\}\s*$/gm;
const WEBHOOK_CRYPTO = /^\s+PAY_CRYPTO_WEBHOOK_SECRET:\s*\$\{PAY_CRYPTO_WEBHOOK_SECRET:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const WEBHOOK_SANDBOX =
  /^\s+PAY_CARD_SANDBOX_WEBHOOK_SECRET:\s*\$\{PAY_CARD_SANDBOX_WEBHOOK_SECRET:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const WATCHER_ENABLED = /^\s+PAY_CRYPTO_WATCHER_ENABLED:\s*\$\{PAY_CRYPTO_WATCHER_ENABLED:-true\}\s*$/gm;
const WATCHER_INTERVAL = /^\s+PAY_CRYPTO_WATCHER_INTERVAL_MS:\s*\$\{PAY_CRYPTO_WATCHER_INTERVAL_MS:-2000\}\s*$/gm;
const CONFIRMATIONS = /^\s+PAY_MIN_CONFIRMATIONS:\s*\$\{PAY_MIN_CONFIRMATIONS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const CHECKOUT_TTL =
  /^\s+PAY_CHECKOUT_SESSION_TTL_SECONDS:\s*\$\{PAY_CHECKOUT_SESSION_TTL_SECONDS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const BASE_PATH = /^\s+PAY_PUBLIC_BASE_PATH:\s*\$\{PAY_PUBLIC_BASE_PATH:-\/api\/pay\}\s*$/gm;
const SANDBOX = /^\s+PAY_ALLOW_SANDBOX_RAILS:\s*\$\{PAY_ALLOW_SANDBOX_RAILS:-false\}\s*$/gm;
const MAX_OPEN =
  /^\s+PAY_CHECKOUT_MAX_OPEN_SESSIONS:\s*\$\{PAY_CHECKOUT_MAX_OPEN_SESSIONS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const RISK_BAND = /^\s+PAY_CHECKOUT_RISK_BAND:\s*\$\{PAY_CHECKOUT_RISK_BAND:-\}\s*$/gm;
const DEFAULT_TTL = /^\s+PAY_LINK_DEFAULT_TTL_DAYS:\s*\$\{PAY_LINK_DEFAULT_TTL_DAYS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const MAX_TTL = /^\s+PAY_LINK_MAX_TTL_DAYS:\s*\$\{PAY_LINK_MAX_TTL_DAYS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const WEBHOOK_TOLERANCE =
  /^\s+PAY_WEBHOOK_TOLERANCE_SECONDS:\s*\$\{PAY_WEBHOOK_TOLERANCE_SECONDS:\?missing — copy \.env\.example to \.env\}\s*$/gm;

describe('compose operator-credit rails for svc-pay', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-pay/src/env.ts'), 'utf8');
  const block = payServiceBlock(compose);

  it('env.ts still declares the flag this pin tracks; no invented card-sandbox', () => {
    expect(envTs).toMatch(/PAY_OPERATOR_CREDIT_RAILS:\s*operatorCreditRailsSchema/);
    expect(envTs).not.toMatch(/PAY_OPERATOR_CREDIT_RAILS:[\s\S]{0,120}\.default\('card-sandbox'\)/);
  });

  it('compose svc-pay block passes unique key once; empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-pay/);
    expect(block.match(OPERATOR_CREDIT)).toHaveLength(1);
    expect(block).not.toMatch(/PAY_OPERATOR_CREDIT_RAILS:\s*\$\{PAY_OPERATOR_CREDIT_RAILS:-card-sandbox\}/);
    expect(block).not.toMatch(/PAY_OPERATOR_CREDIT_RAILS:\s*card-sandbox/);
  });

  it('does not restamp webhook/watcher/checkout/link keys or invent fee/checkout rails/RPC', () => {
    expect(block.match(WEBHOOK_CRYPTO)).toHaveLength(1);
    expect(block.match(WEBHOOK_SANDBOX)).toHaveLength(1);
    expect(block.match(WATCHER_ENABLED)).toHaveLength(1);
    expect(block.match(WATCHER_INTERVAL)).toHaveLength(1);
    expect(block.match(CONFIRMATIONS)).toHaveLength(1);
    expect(block.match(CHECKOUT_TTL)).toHaveLength(1);
    expect(block.match(BASE_PATH)).toHaveLength(1);
    expect(block.match(SANDBOX)).toHaveLength(1);
    expect(block.match(MAX_OPEN)).toHaveLength(1);
    expect(block.match(RISK_BAND)).toHaveLength(1);
    expect(block.match(DEFAULT_TTL)).toHaveLength(1);
    expect(block.match(MAX_TTL)).toHaveLength(1);
    expect(block.match(WEBHOOK_TOLERANCE)).toHaveLength(1);
    expect(block).not.toMatch(/PAY_CHECKOUT_RAILS:/);
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*\$\{PAY_DEFAULT_FEE_BPS:-\d+\}/);
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*['"]?\d+/);
    expect(block).not.toMatch(/PAY_CRYPTO_RPC_URL:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_CHAIN_ID:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_DEPOSIT_SOURCE:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_HOT_WALLET_KEY:\s*\$\{/);
  });
});
