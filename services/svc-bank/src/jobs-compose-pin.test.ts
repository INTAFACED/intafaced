/**
 * Unit card — compose stack passes job kill-switches into svc-bank
 *
 * 1. Promise: SCHEDULED_TRANSFERS_ENABLED and AUTO_INVEST_ENABLED from host
 *    `.env` reach the container (env.ts already declares them).
 * 2. Break: compose booted bank without the names → operator stop is a no-op
 *    and the runner keeps the schema default forever.
 * 3. Done bar: docker-compose.apps.yml svc-bank environment names both keys
 *    with host passthrough matching env.ts defaults (`:-true`).
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-bank block only)
 * 6. RED: pin fails if either name drops off the svc-bank service block
 * 7. Collision: #2123 svc-trade · #2126 svc-p2p — this pin only reads svc-bank
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

const KEYS = ['SCHEDULED_TRANSFERS_ENABLED', 'AUTO_INVEST_ENABLED'] as const;

describe('compose job kill-switches for svc-bank', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-bank/src/env.ts'), 'utf8');
  const block = bankServiceBlock(compose);

  it('env.ts still declares the flags this pin tracks, default true', () => {
    for (const name of KEYS) {
      expect(envTs).toMatch(new RegExp(`${name}:\\s*z`));
      const slice = envTs.slice(envTs.indexOf(`${name}:`));
      expect(slice.slice(0, 400)).toMatch(/\.default\(\s*true\s*\)/);
    }
  });

  it('compose svc-bank block passes both flags from the host with env.ts defaults', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-bank/);
    for (const name of KEYS) {
      expect(block, `${name} missing from svc-bank compose environment`).toMatch(new RegExp(`${name}:\\s*\\$\\{${name}:-true\\}`));
    }
  });

  it('does not invent an auto-invest or transfer rate on the compose block', () => {
    expect(block).not.toMatch(/AUTO_INVEST_(APR|APY|RATE|BPS)/i);
    expect(block).not.toMatch(/SCHEDULED_TRANSFER_(APR|APY|RATE|BPS)/i);
    expect(block).not.toMatch(/DEFAULT_(APR|APY|RATE|BPS)/);
  });
});
