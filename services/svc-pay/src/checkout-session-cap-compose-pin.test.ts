/**
 * Unit card — compose stack passes checkout session cap + risk band into svc-pay
 *
 * 1. Promise: PAY_CHECKOUT_MAX_OPEN_SESSIONS and PAY_CHECKOUT_RISK_BAND from
 *    host `.env` reach the container (env.ts already declares them). Blank cap
 *    refuses — never 25. Owner explicit 25 is allowed. Blank band never invents
 *    `low`.
 * 2. Break: compose booted pay without the names → operator cap/band is a
 *    no-op; a compose `:-25` makes blank look published.
 * 3. Done bar: docker-compose.apps.yml svc-pay has
 *    PAY_CHECKOUT_MAX_OPEN_SESSIONS: ${PAY_CHECKOUT_MAX_OPEN_SESSIONS:?missing — copy .env.example to .env}
 *    PAY_CHECKOUT_RISK_BAND: ${PAY_CHECKOUT_RISK_BAND:-}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-pay block only)
 * 6. RED: pin fails if a unique key drops, cap bakes 25, risk band
 *    invents `low`, or a baked PAY_DEFAULT_FEE_BPS magnitude / sandbox-on / RPC / mnemonic /
 *    hot wallet / card rails appear
 * 7. Collision: checkout-compose-flags-pin.test.ts and
 *    crypto-watcher-compose-pin.test.ts — this pin does not restamp
 *    PAY_MIN_CONFIRMATIONS / watcher / ALLOW_SANDBOX_RAILS
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

const MAX_OPEN =
  /^\s+PAY_CHECKOUT_MAX_OPEN_SESSIONS:\s*\$\{PAY_CHECKOUT_MAX_OPEN_SESSIONS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const RISK_BAND = /^\s+PAY_CHECKOUT_RISK_BAND:\s*\$\{PAY_CHECKOUT_RISK_BAND:-\}\s*$/gm;

describe('compose checkout session cap and risk band for svc-pay', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-pay/src/env.ts'), 'utf8');
  const block = payServiceBlock(compose);

  it('env.ts still declares the flags this pin tracks; cap has no invented 25', () => {
    expect(envTs).toMatch(/PAY_CHECKOUT_MAX_OPEN_SESSIONS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(10_000\),/);
    expect(envTs).not.toMatch(/PAY_CHECKOUT_MAX_OPEN_SESSIONS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(10_000\)\.default\(25\)/);
    expect(envTs).toMatch(/PAY_CHECKOUT_RISK_BAND:\s*z\.string\(\)\.optional\(\)\.default\(''\)/);
  });

  it('compose svc-pay block passes unique keys once; cap missing refuses; risk band empty', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-pay/);
    expect(block.match(MAX_OPEN)).toHaveLength(1);
    expect(block.match(RISK_BAND)).toHaveLength(1);
    expect(block).not.toMatch(/PAY_CHECKOUT_MAX_OPEN_SESSIONS:\s*\$\{PAY_CHECKOUT_MAX_OPEN_SESSIONS:-25\}/);
    expect(block).not.toMatch(/PAY_CHECKOUT_RISK_BAND:\s*\$\{PAY_CHECKOUT_RISK_BAND:-low\}/);
  });

  it('does not restamp confirmations/watcher/sandbox or invent fee/RPC/mnemonic/hot wallet/card rails', () => {
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*\$\{PAY_DEFAULT_FEE_BPS:-\d+\}/);
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*['"]?\d+/);
    expect(block).not.toMatch(/PAY_CRYPTO_RPC_URL:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_DEPOSIT_SOURCE:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_HOT_WALLET_KEY:\s*\$\{/);
    expect(block).not.toMatch(/PAY_ALLOW_SANDBOX_RAILS:\s*\$\{PAY_ALLOW_SANDBOX_RAILS:-true\}/);
  });
});
