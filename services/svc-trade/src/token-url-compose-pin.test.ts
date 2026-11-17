/**
 * Unit card — compose stack points svc-trade TOKEN_URL at the fleet svc-token
 *
 * 1. Promise: OTC stake-gate (`createOtcStakeSource(env.TOKEN_URL, …)`) reaches
 *    svc-token on the compose network. env.ts already defaults
 *    `http://localhost:4003`.
 * 2. Break: compose booted trade with IDENTITY_URL / LEDGER_URL / MATCHING_URL
 *    but no TOKEN_URL → stake-gate calls localhost inside the container and
 *    miss svc-token even though token is on the network.
 * 3. Done bar: docker-compose.apps.yml svc-trade has
 *    TOKEN_URL: http://svc-token:4003
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-trade block only)
 * 6. RED: pin fails if TOKEN_URL drops, is duplicated in the trade block, or
 *    is not http://svc-token:4003
 * 7. Collision: jwt-access-ttl-compose-pin.test.ts and other trade compose
 *    pins — this pin does not restamp JWT_*, TRADE_SPOT_ENABLED, TRADE_MM_*,
 *    TRADE_ALGO_*, TRADE_CONVERT_*, TRADE_FUTURES_*, TRADE_COPY_*, TRADE_OTC_*,
 *    TRADE_CANDLE_*, TRADE_RECONCILE_*. Do not invent OTC JSON/mids, turn
 *    futures ON, or add YIELD / fee bps.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const ENV_TS = resolve(import.meta.dirname, './env.ts');

function tradeServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-trade');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const TOKEN_URL = /^\s+TOKEN_URL:\s*http:\/\/svc-token:4003\s*$/gm;

describe('compose TOKEN_URL for svc-trade OTC stake-gate', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const envTs = readFileSync(ENV_TS, 'utf8');
  const block = tradeServiceBlock(compose);

  it('env.ts still defaults TOKEN_URL to localhost:4003 (compose must override)', () => {
    expect(envTs).toMatch(/TOKEN_URL:\s*z\.string\(\)\.url\(\)\.default\('http:\/\/localhost:4003'\)/);
  });

  it('wires TOKEN_URL once in the trade block to the fleet svc-token', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-trade/);
    expect(block.match(TOKEN_URL)).toHaveLength(1);
    expect(countAssignments(block, 'TOKEN_URL')).toBe(1);
  });
});
