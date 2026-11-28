/**
 * Unit card — compose stack passes checkout + confirmation flags into svc-pay
 *
 * 1. Promise: PAY_MIN_CONFIRMATIONS, PAY_CHECKOUT_SESSION_TTL_SECONDS,
 *    PAY_PUBLIC_BASE_PATH, and PAY_ALLOW_SANDBOX_RAILS from host `.env` reach
 *    the container (env.ts already declares them). Blank confirmations refuse
 *    — never settle as 6. Owner explicit 6 is allowed. Blank session TTL
 *    refuses — never 900. Owner explicit 900 is allowed.
 * 2. Break: compose booted pay with only webhook secrets + watcher flags →
 *    operator pin of confirmations / session TTL / public path is a no-op, and
 *    sandbox rails stay whatever schema default the process happens to load.
 *    A compose `:-6` / `:-900` makes blank look published.
 * 3. Done bar: docker-compose.apps.yml svc-pay has
 *    PAY_MIN_CONFIRMATIONS: ${PAY_MIN_CONFIRMATIONS:?missing — copy .env.example to .env}
 *    PAY_CHECKOUT_SESSION_TTL_SECONDS: ${PAY_CHECKOUT_SESSION_TTL_SECONDS:?missing — copy .env.example to .env}
 *    PAY_PUBLIC_BASE_PATH: ${PAY_PUBLIC_BASE_PATH:-/api/pay}
 *    PAY_ALLOW_SANDBOX_RAILS: ${PAY_ALLOW_SANDBOX_RAILS:-false}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-pay block only)
 * 6. RED: pin fails if a unique key drops, sandbox default flips true, or
 *    a baked PAY_DEFAULT_FEE_BPS magnitude / RPC / mnemonic / hot wallet / card rails appear
 * 7. Collision: crypto-watcher-compose-pin.test.ts — this pin does not restamp
 *    PAY_CRYPTO_WATCHER_*
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';
import { payEnv } from './env.testkit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function payServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-pay');
}

const CONFIRMATIONS = /^\s+PAY_MIN_CONFIRMATIONS:\s*\$\{PAY_MIN_CONFIRMATIONS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const TTL = /^\s+PAY_CHECKOUT_SESSION_TTL_SECONDS:\s*\$\{PAY_CHECKOUT_SESSION_TTL_SECONDS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const BASE_PATH = /^\s+PAY_PUBLIC_BASE_PATH:\s*\$\{PAY_PUBLIC_BASE_PATH:-\/api\/pay\}\s*$/gm;
const SANDBOX = /^\s+PAY_ALLOW_SANDBOX_RAILS:\s*\$\{PAY_ALLOW_SANDBOX_RAILS:-false\}\s*$/gm;
const WATCHER_ENABLED = /^\s+PAY_CRYPTO_WATCHER_ENABLED:\s*\$\{PAY_CRYPTO_WATCHER_ENABLED:-true\}\s*$/gm;
const WATCHER_INTERVAL = /^\s+PAY_CRYPTO_WATCHER_INTERVAL_MS:\s*\$\{PAY_CRYPTO_WATCHER_INTERVAL_MS:-2000\}\s*$/gm;

describe('compose checkout and confirmation flags for svc-pay', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = payServiceBlock(compose);

  it('svc-pay reads the flags this pin tracks, with the same defaults compose has', () => {
    // Blank or missing confirmations and session lifetime refuse the boot: never 6, never 900.
    for (const blank of [undefined, '', '0']) {
      expect(() => payEnv({ PAY_MIN_CONFIRMATIONS: blank })).toThrow(/PAY_MIN_CONFIRMATIONS/);
      expect(() => payEnv({ PAY_CHECKOUT_SESSION_TTL_SECONDS: blank })).toThrow(/PAY_CHECKOUT_SESSION_TTL_SECONDS/);
    }
    expect(() => payEnv({ PAY_CHECKOUT_SESSION_TTL_SECONDS: '86401' })).toThrow(/PAY_CHECKOUT_SESSION_TTL_SECONDS/);
    expect(payEnv({ PAY_MIN_CONFIRMATIONS: '6' }).PAY_MIN_CONFIRMATIONS).toBe(6);
    expect(payEnv({ PAY_CHECKOUT_SESSION_TTL_SECONDS: '900' }).PAY_CHECKOUT_SESSION_TTL_SECONDS).toBe(900);
    // The public path and the sandbox switch default as compose does.
    expect(payEnv({ PAY_PUBLIC_BASE_PATH: undefined }).PAY_PUBLIC_BASE_PATH).toBe('/api/pay');
    expect(payEnv({ PAY_ALLOW_SANDBOX_RAILS: undefined }).PAY_ALLOW_SANDBOX_RAILS).toBe('false');
    expect(payEnv({ PAY_ALLOW_SANDBOX_RAILS: 'true' }).PAY_ALLOW_SANDBOX_RAILS).toBe('true');
  });

  it('compose svc-pay block passes unique keys once; sandbox default stays false', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-pay/);
    expect(block.match(CONFIRMATIONS)).toHaveLength(1);
    expect(block.match(TTL)).toHaveLength(1);
    expect(block.match(BASE_PATH)).toHaveLength(1);
    expect(block.match(SANDBOX)).toHaveLength(1);
    expect(block).not.toMatch(/PAY_ALLOW_SANDBOX_RAILS:\s*\$\{PAY_ALLOW_SANDBOX_RAILS:-true\}/);
  });

  it('does not restamp watcher flags or invent fee/RPC/mnemonic/hot wallet/card rails', () => {
    expect(block.match(WATCHER_ENABLED)).toHaveLength(1);
    expect(block.match(WATCHER_INTERVAL)).toHaveLength(1);
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*\$\{PAY_DEFAULT_FEE_BPS:-\d+\}/);
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*['"]?\d+/);
    expect(block).not.toMatch(/PAY_CRYPTO_RPC_URL:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_DEPOSIT_SOURCE:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_HOT_WALLET_KEY:\s*\$\{/);
  });
});
