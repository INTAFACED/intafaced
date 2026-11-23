/**
 * Unit card — compose stack passes BANK_RAMP_MODE into svc-bank
 *
 * 1. Promise: host `.env` can pin the ramp programme (env.ts already declares
 *    BANK_RAMP_MODE = none | crypto-ledger, default none).
 * 2. Break: compose booted bank without the name → operator opt-in is a no-op
 *    and the container keeps the schema default forever (always none).
 * 3. Done bar: docker-compose.apps.yml svc-bank has
 *    BANK_RAMP_MODE: ${BANK_RAMP_MODE:-none}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-bank block only)
 * 6. RED: pin fails if the key drops off, appears twice, defaults to
 *    crypto-ledger, or fiat PSP / APY sneak in
 * 7. Collision: jobs/loans/earn/cards compose pins — this pin only names BANK_RAMP_MODE
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

describe('compose BANK_RAMP_MODE for svc-bank', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-bank/src/env.ts'), 'utf8');
  const block = bankServiceBlock(compose);

  it('env.ts still declares BANK_RAMP_MODE enum default none', () => {
    expect(envTs).toMatch(/BANK_RAMP_MODE:\s*z\.enum\(RAMP_SETTINGS\)\.default\('none'\)/);
  });

  it('compose svc-bank block is the unique home of the key, default none', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-bank/);
    expect(block).toMatch(/BANK_RAMP_MODE:\s*\$\{BANK_RAMP_MODE:-none\}/);
    expect(block).not.toMatch(/BANK_RAMP_MODE:\s*\$\{BANK_RAMP_MODE:-crypto-ledger\}/);

    const hits = compose.match(/^\s+BANK_RAMP_MODE:/gm) ?? [];
    expect(hits, 'BANK_RAMP_MODE must appear once (svc-bank only)').toHaveLength(1);
  });

  it('does not add fiat PSP, chain broadcast, or APY', () => {
    expect(block).not.toMatch(/^\s+[A-Z0-9_]*(PSP_|FIAT_RAMP|CHAIN_BROADCAST|APY)[A-Z0-9_]*:/im);
  });
});
