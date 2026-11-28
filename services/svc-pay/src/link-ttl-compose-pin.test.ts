/**
 * Unit card — compose stack passes payment-link TTL + webhook tolerance into svc-pay
 *
 * 1. Promise: PAY_LINK_DEFAULT_TTL_DAYS, PAY_LINK_MAX_TTL_DAYS, and
 *    PAY_WEBHOOK_TOLERANCE_SECONDS from host `.env` reach the container
 *    (env.ts already declares them). Blank default-TTL / max-TTL refuse —
 *    never 30 / 365. Owner explicit 30 / 365 is allowed.
 * 2. Break: compose booted pay with watcher / checkout / sandbox / risk band
 *    but no link lifetime or webhook skew window → operator pin of TTL /
 *    replay window is a no-op and the process keeps schema defaults forever.
 *    A compose `:-30` / `:-365` makes blank look published.
 * 3. Done bar: docker-compose.apps.yml svc-pay has
 *    PAY_LINK_DEFAULT_TTL_DAYS: ${PAY_LINK_DEFAULT_TTL_DAYS:?missing — copy .env.example to .env}
 *    PAY_LINK_MAX_TTL_DAYS: ${PAY_LINK_MAX_TTL_DAYS:?missing — copy .env.example to .env}
 *    PAY_WEBHOOK_TOLERANCE_SECONDS: ${PAY_WEBHOOK_TOLERANCE_SECONDS:?missing — copy .env.example to .env}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-pay block only)
 * 6. RED: pin fails if a unique key drops, defaults drift from env.ts, or
 *    a baked PAY_DEFAULT_FEE_BPS magnitude / PAY_CHECKOUT_RAILS / sandbox-on appear
 * 7. Collision: checkout-compose-flags-pin.test.ts,
 *    checkout-session-cap-compose-pin.test.ts, and
 *    crypto-watcher-compose-pin.test.ts — this pin does not restamp
 *    PAY_CHECKOUT_MAX_OPEN_SESSIONS / RISK_BAND / MIN_CONFIRMATIONS / WATCHER
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

const DEFAULT_TTL = /^\s+PAY_LINK_DEFAULT_TTL_DAYS:\s*\$\{PAY_LINK_DEFAULT_TTL_DAYS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const MAX_TTL = /^\s+PAY_LINK_MAX_TTL_DAYS:\s*\$\{PAY_LINK_MAX_TTL_DAYS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const WEBHOOK_TOLERANCE =
  /^\s+PAY_WEBHOOK_TOLERANCE_SECONDS:\s*\$\{PAY_WEBHOOK_TOLERANCE_SECONDS:\?missing — copy \.env\.example to \.env\}\s*$/gm;

describe('compose payment-link TTL and webhook tolerance for svc-pay', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = payServiceBlock(compose);

  it('svc-pay refuses each of the three missing, as compose does — no 30, 365 or 300 of its own', () => {
    for (const key of ['PAY_LINK_DEFAULT_TTL_DAYS', 'PAY_LINK_MAX_TTL_DAYS', 'PAY_WEBHOOK_TOLERANCE_SECONDS']) {
      expect(() => payEnv({ [key]: undefined })).toThrow(new RegExp(key));
      expect(() => payEnv({ [key]: '' })).toThrow(new RegExp(key));
    }
    expect(() => payEnv({ PAY_WEBHOOK_TOLERANCE_SECONDS: '29' })).toThrow(/PAY_WEBHOOK_TOLERANCE_SECONDS/);
    const given = payEnv({ PAY_LINK_DEFAULT_TTL_DAYS: '30', PAY_LINK_MAX_TTL_DAYS: '365', PAY_WEBHOOK_TOLERANCE_SECONDS: '300' });
    expect([given.PAY_LINK_DEFAULT_TTL_DAYS, given.PAY_LINK_MAX_TTL_DAYS, given.PAY_WEBHOOK_TOLERANCE_SECONDS]).toEqual([30, 365, 300]);
  });

  it('compose svc-pay block passes unique keys once; default/max TTL and webhook tolerance refuse', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-pay/);
    expect(block.match(DEFAULT_TTL)).toHaveLength(1);
    expect(block.match(MAX_TTL)).toHaveLength(1);
    expect(block.match(WEBHOOK_TOLERANCE)).toHaveLength(1);
  });

  it('does not restamp session/watcher/sandbox or invent fee bps / rail list', () => {
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*\$\{PAY_DEFAULT_FEE_BPS:-\d+\}/);
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*['"]?\d+/);
    expect(block).not.toMatch(/PAY_CHECKOUT_RAILS:/);
    expect(block).not.toMatch(/PAY_ALLOW_SANDBOX_RAILS:\s*\$\{PAY_ALLOW_SANDBOX_RAILS:-true\}/);
    expect(block).not.toMatch(/PAY_CRYPTO_RPC_URL:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_DEPOSIT_SOURCE:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_HOT_WALLET_KEY:\s*\$\{/);
  });
});
