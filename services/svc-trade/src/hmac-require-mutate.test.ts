/**
 * Mutate S2S doors bind HMAC to retained bytes (`mode: 'require'`).
 * Compose INTERNAL_SERVICE_BODY_BIND stays accept-both — do not mill that pin.
 * copy-leader-fixtures GET stays env (accept-both until operator sets require).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = dirname(fileURLToPath(import.meta.url));

function sliceRegister(index: string, marker: string, nextMarkers: readonly string[]): string {
  const at = index.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const ends = nextMarkers.map((m) => index.indexOf(m, at + marker.length)).filter((i) => i > at);
  const end = ends.length === 0 ? at + 600 : Math.min(...ends);
  return index.slice(at, end);
}

describe('svc-trade mutate S2S HMAC require', () => {
  it('funding-rate and outcomes settle hardcode require; copy-leader GET stays env', () => {
    const index = readFileSync(join(DIR, 'index.ts'), 'utf8');
    const funding = readFileSync(join(DIR, 'futures/internal-funding-rate.ts'), 'utf8');
    const outcomes = readFileSync(join(DIR, 'outcomes-rest.ts'), 'utf8');
    const fixtures = readFileSync(join(DIR, 'agents/copy-leader-fixtures-routes.ts'), 'utf8');

    expect(funding).toMatch(/bodyBindMode:\s*'require'/);
    expect(funding).not.toMatch(/DEFAULT_SERVICE_BODY_BIND_MODE/);
    expect(funding).not.toMatch(/bodyBind(?!Mode)/);
    expect(outcomes).toMatch(/bodyBindMode:\s*'require'/);
    expect(outcomes).not.toMatch(/DEFAULT_SERVICE_BODY_BIND_MODE/);
    expect(outcomes).not.toMatch(/bodyBind(?!Mode)/);

    const fundingReg = sliceRegister(index, 'registerInternalFundingRate(app, {', ['registerMarketLifecycleRoutes']);
    expect(fundingReg).not.toMatch(/INTERNAL_SERVICE_BODY_BIND/);
    const outcomesReg = sliceRegister(index, 'registerOutcomesRest(app, {', ['installGtdGttPlace']);
    expect(outcomesReg).not.toMatch(/INTERNAL_SERVICE_BODY_BIND/);

    expect(fixtures).toMatch(/deps\.bodyBind \?\? DEFAULT_SERVICE_BODY_BIND_MODE/);
    const fixturesReg = sliceRegister(index, 'registerCopyLeaderFixturesRoutes(app, {', ['registerOutcomesRest']);
    expect(fixturesReg).toMatch(/bodyBind:\s*env\.INTERNAL_SERVICE_BODY_BIND/);
  });
});
