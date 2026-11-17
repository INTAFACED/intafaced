/**
 * Unit card — compose stack passes cards module kill into svc-bank
 *
 * 1. Promise: BANK_CARDS_ENABLED from host `.env` reaches the container
 *    (env.ts already declares it, default true).
 * 2. Break: compose booted bank without the name → operator stop is a no-op
 *    unless they also change BANK_CARD_ISSUER.
 * 3. Done bar: docker-compose.apps.yml svc-bank has
 *    BANK_CARDS_ENABLED: ${BANK_CARDS_ENABLED:-true}
 *    and BANK_CARD_ISSUER stays ${BANK_CARD_ISSUER:-none}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-bank block only)
 * 6. RED: pin fails if the key drops off, appears twice, default is not true,
 *    issuer default leaves none, or a live issuer / BIN / scheme is named
 * 7. Collision: ramp/jobs/loans/earn compose pins — this pin only names cards
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

describe('compose BANK_CARDS_ENABLED for svc-bank', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-bank/src/env.ts'), 'utf8');
  const block = bankServiceBlock(compose);

  it('env.ts still declares BANK_CARDS_ENABLED default true', () => {
    expect(envTs).toMatch(/BANK_CARDS_ENABLED:\s*z/);
    const slice = envTs.slice(envTs.indexOf('BANK_CARDS_ENABLED:'));
    expect(slice.slice(0, 400)).toMatch(/\.default\(\s*true\s*\)/);
  });

  it('compose svc-bank block is the unique home of the key, default true', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-bank/);
    expect(block).toMatch(/BANK_CARDS_ENABLED:\s*\$\{BANK_CARDS_ENABLED:-true\}/);

    const hits = compose.match(/^\s+BANK_CARDS_ENABLED:/gm) ?? [];
    expect(hits, 'BANK_CARDS_ENABLED must appear once (svc-bank only)').toHaveLength(1);
  });

  it('keeps BANK_CARD_ISSUER at none and does not invent a live issuer, BIN, or scheme', () => {
    expect(block).toMatch(/BANK_CARD_ISSUER:\s*\$\{BANK_CARD_ISSUER:-none\}/);
    expect(block).not.toMatch(/BANK_CARD_ISSUER:\s*\$\{BANK_CARD_ISSUER:-card-sim\}/);
    expect(block).not.toMatch(/BANK_CARDS_ENABLED:\s*\$\{BANK_CARDS_ENABLED:-false\}/);
    expect(block).not.toMatch(/ISSUING_BIN|CARD_SCHEME|LIVE_ISSUER|CARD_BIN/i);
  });
});
