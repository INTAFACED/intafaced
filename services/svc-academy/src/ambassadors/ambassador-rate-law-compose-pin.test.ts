/**
 * Unit card — compose stack passes ambassador rate-law JSON into svc-academy
 *
 * 1. Promise: ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON and
 *    ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON from host `.env` reach the
 *    container (env.ts already declares them, empty default = unpublished refuse).
 * 2. Break: compose booted academy without the keys → owner JSON is a no-op and
 *    the process cannot see published law even when the host sets it.
 * 3. Done bar: docker-compose.apps.yml svc-academy has
 *    ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON: ${ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON:-}
 *    ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON: ${ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON:-}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-academy block) + this pin
 * 6. RED: pin fails if a key drops, appears twice, or defaults a rate JSON
 * 7. Collision: do not restamp STREAM_PROVIDER / MAX_ROOM_CAPACITY /
 *    PAPER_TRADING / TOURNAMENT. No invented prize pools or IFC amounts.
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

const IFC_PAY_LAW = /^\s+ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON:\s*\$\{ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON:-\}\s*$/gm;
const REVENUE_SHARE_LAW = /^\s+ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON:\s*\$\{ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON:-\}\s*$/gm;

describe('compose ambassador rate-law for svc-academy', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-academy/src/env.ts'), 'utf8');
  const block = academyServiceBlock(compose);

  it('env.ts still declares empty defaults (unpublished refuse)', () => {
    expect(envTs).toMatch(/ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON:\s*z\.string\(\)\.optional\(\)\.default\(''\)/);
    expect(envTs).toMatch(/ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON:\s*z\.string\(\)\.optional\(\)\.default\(''\)/);
  });

  it('compose svc-academy block is the unique home of both keys (empty default)', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-academy/);
    expect(block.match(IFC_PAY_LAW)).toHaveLength(1);
    expect(block.match(REVENUE_SHARE_LAW)).toHaveLength(1);

    const ifcHits = compose.match(/^\s+ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON:/gm) ?? [];
    const shareHits = compose.match(/^\s+ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON:/gm) ?? [];
    expect(ifcHits, 'ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON must appear once').toHaveLength(1);
    expect(shareHits, 'ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON must appear once').toHaveLength(1);
  });

  it('does not restamp kills or invent prize / IFC / fee-percent defaults', () => {
    expect(block).toMatch(/ACADEMY_STREAM_PROVIDER:\s*\$\{ACADEMY_STREAM_PROVIDER:-none\}/);
    expect(block).toMatch(/ACADEMY_MAX_ROOM_CAPACITY:\s*\$\{ACADEMY_MAX_ROOM_CAPACITY:-\}/);
    expect(block).toMatch(/ACADEMY_PAPER_TRADING_ENABLED:\s*\$\{ACADEMY_PAPER_TRADING_ENABLED:-true\}/);
    expect(block).toMatch(/ACADEMY_TOURNAMENT_ENABLED:\s*\$\{ACADEMY_TOURNAMENT_ENABLED:-true\}/);
    expect(block).not.toMatch(/ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON:\s*\$\{ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON:-\{/);
    expect(block).not.toMatch(/ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON:\s*\$\{ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON:-\{/);
    expect(block).not.toMatch(/PRIZE_POOL|PAPER_BALANCE|shareOfFeeBps|sessionCredit/i);
  });
});
