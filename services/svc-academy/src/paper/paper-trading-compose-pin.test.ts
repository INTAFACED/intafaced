/**
 * Unit card — compose stack passes paper-trading kill into svc-academy
 *
 * 1. Promise: ACADEMY_PAPER_TRADING_ENABLED from host `.env` reaches the container
 *    (env.ts already declares it, default true).
 * 2. Break: compose booted academy without the key → operator stop is a no-op.
 * 3. Done bar: docker-compose.apps.yml svc-academy has
 *    ACADEMY_PAPER_TRADING_ENABLED: ${ACADEMY_PAPER_TRADING_ENABLED:-true}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-academy block) + this pin
 * 6. RED: pin fails if the key drops off, appears twice, or defaults off
 * 7. Collision: do not restamp STREAM_PROVIDER / MAX_ROOM_CAPACITY. Tournament
 *    kill and ambassador rate-law are separate compose pins. No prize pools
 *    or paper-balance keys here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function academyServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-academy');
}

describe('compose paper-trading kill for svc-academy', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-academy/src/env.ts'), 'utf8');
  const block = academyServiceBlock(compose);

  it('env.ts still declares ACADEMY_PAPER_TRADING_ENABLED default true', () => {
    expect(envTs).toMatch(/ACADEMY_PAPER_TRADING_ENABLED:\s*z/);
    const slice = envTs.slice(envTs.indexOf('ACADEMY_PAPER_TRADING_ENABLED:'));
    expect(slice.slice(0, 400)).toMatch(/\.default\(\s*true\s*\)/);
  });

  it('compose svc-academy block is the unique home of the key (default true)', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-academy/);
    expect(block).toMatch(/ACADEMY_PAPER_TRADING_ENABLED:\s*\$\{ACADEMY_PAPER_TRADING_ENABLED:-true\}/);

    const hits = compose.match(/^\s+ACADEMY_PAPER_TRADING_ENABLED:/gm) ?? [];
    expect(hits, 'ACADEMY_PAPER_TRADING_ENABLED must appear once (svc-academy only)').toHaveLength(1);
    expect(block).not.toMatch(/ACADEMY_PAPER_TRADING_ENABLED:\s*\$\{ACADEMY_PAPER_TRADING_ENABLED:-false\}/);
  });

  it('does not invent prize-pool or paper-balance keys', () => {
    expect(block).not.toMatch(/PRIZE_POOL|PAPER_BALANCE/i);
  });
});
