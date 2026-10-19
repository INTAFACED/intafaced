/**
 * Unit card — compose stack passes crypto watcher flags into svc-pay
 *
 * 1. Promise: PAY_CRYPTO_WATCHER_ENABLED and PAY_CRYPTO_WATCHER_INTERVAL_MS
 *    from host `.env` reach the container (env.ts already declares them).
 * 2. Break: compose booted pay without the names → operator stop/retune is a
 *    no-op and the watcher keeps the schema default forever.
 * 3. Done bar: docker-compose.apps.yml svc-pay has
 *    PAY_CRYPTO_WATCHER_ENABLED: ${PAY_CRYPTO_WATCHER_ENABLED:-true}
 *    PAY_CRYPTO_WATCHER_INTERVAL_MS: ${PAY_CRYPTO_WATCHER_INTERVAL_MS:-2000}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-pay block only)
 * 6. RED: pin fails if either name drops off the svc-pay service block
 * 7. Collision: none — this pin only reads svc-pay + env.ts
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

const ENABLED = 'PAY_CRYPTO_WATCHER_ENABLED';
const INTERVAL = 'PAY_CRYPTO_WATCHER_INTERVAL_MS';
const ENABLED_LINE = /^\s+PAY_CRYPTO_WATCHER_ENABLED:\s*\$\{PAY_CRYPTO_WATCHER_ENABLED:-true\}\s*$/gm;
const INTERVAL_LINE = /^\s+PAY_CRYPTO_WATCHER_INTERVAL_MS:\s*\$\{PAY_CRYPTO_WATCHER_INTERVAL_MS:-2000\}\s*$/gm;

describe('compose crypto watcher flags for svc-pay', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-pay/src/env.ts'), 'utf8');
  const block = payServiceBlock(compose);

  it('env.ts still declares the flags this pin tracks, matching compose defaults', () => {
    expect(envTs).toMatch(new RegExp(`${ENABLED}:\\s*z\\.enum\\(\\['true',\\s*'false'\\]\\)\\.default\\('true'\\)`));
    expect(envTs).toMatch(
      new RegExp(`${INTERVAL}:\\s*z\\.coerce\\.number\\(\\)\\.int\\(\\)\\.min\\(500\\)\\.max\\(60_000\\)\\.default\\(2_000\\)`),
    );
  });

  it('compose svc-pay block passes both flags from the host, unique keys once', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-pay/);
    expect(block.match(ENABLED_LINE)).toHaveLength(1);
    expect(block.match(INTERVAL_LINE)).toHaveLength(1);
  });

  it('does not invent RPC, mnemonic, hot wallet, card rails, or sandbox rails', () => {
    expect(block).not.toMatch(/PAY_CRYPTO_RPC_URL:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_DEPOSIT_SOURCE:\s*\$\{/);
    expect(block).not.toMatch(/PAY_CRYPTO_HOT_WALLET_KEY:\s*\$\{/);
    expect(block).not.toMatch(/PAY_ALLOW_SANDBOX_RAILS:\s*\$\{PAY_ALLOW_SANDBOX_RAILS:-true\}/);
  });
});
