/**
 * Unit card — compose stack passes access-token TTL / issuer / audience into
 * svc-trade
 *
 * 1. Promise: host `.env` can pin JWT_ACCESS_TTL_SECONDS, JWT_ISSUER, and
 *    JWT_AUDIENCE for the trade container (authEnvSchema defaults 900 /
 *    intafaced / intafaced.api).
 * 2. Break: compose named spot kill / futures / MM / convert / copy / OTC /
 *    options but not these three → operator pin is a no-op and the container
 *    keeps schema-only defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-trade has
 *    JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}
 *    JWT_ISSUER: ${JWT_ISSUER:-intafaced}
 *    JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-trade block only)
 * 6. RED: pin fails if a line drops, is duplicated in the trade block, or the
 *    compose default is not 900 / intafaced / intafaced.api
 * 7. Collision: this pin does not restamp TRADE_SPOT_ENABLED, TRADE_FUTURES_*,
 *    MM seed, convert, algo, candle, reconcile, OTC, copy, or options, and it
 *    does not add JWT_ACCESS_SECRET
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authEnvSchema } from '@intafaced/config';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

function tradeServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-trade');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;

describe('compose JWT access TTL issuer audience for svc-trade', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const block = tradeServiceBlock(compose);

  it('authEnvSchema still defaults TTL 900 issuer intafaced audience intafaced.api', () => {
    const unset = authEnvSchema.parse({ JWT_ACCESS_SECRET: 'test-only-jwt-access-secret-0123456789' });
    expect(unset.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(unset.JWT_ISSUER).toBe('intafaced');
    expect(unset.JWT_AUDIENCE).toBe('intafaced.api');
    // The TTL stays bounded: a minute to an hour.
    expect(() =>
      authEnvSchema.parse({ JWT_ACCESS_SECRET: 'test-only-jwt-access-secret-0123456789', JWT_ACCESS_TTL_SECONDS: '59' }),
    ).toThrow();
    expect(() =>
      authEnvSchema.parse({ JWT_ACCESS_SECRET: 'test-only-jwt-access-secret-0123456789', JWT_ACCESS_TTL_SECONDS: '3601' }),
    ).toThrow();
  });

  it('wires each JWT key from the host once in the trade block with identity defaults', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-trade/);
    expect(block.match(TTL)).toHaveLength(1);
    expect(block.match(ISSUER)).toHaveLength(1);
    expect(block.match(AUDIENCE)).toHaveLength(1);
    expect(countAssignments(block, 'JWT_ACCESS_TTL_SECONDS')).toBe(1);
    expect(countAssignments(block, 'JWT_ISSUER')).toBe(1);
    expect(countAssignments(block, 'JWT_AUDIENCE')).toBe(1);
  });

  it('does not add JWT_ACCESS_SECRET on svc-trade', () => {
    expect(countAssignments(block, 'JWT_ACCESS_SECRET')).toBe(0);
  });
});
