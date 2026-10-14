/**
 * Unit card — compose stack passes emissions kill + auto-tick into svc-token
 *
 * 1. Promise: host `.env` can kill minting and keep auto-tick OFF in the live
 *    container (env.ts already declares EMISSIONS_ENABLED / AUTO_TICK / TICK_MS).
 * 2. Break: compose booted token with only TOKEN_ASSET_ID → operator flags are
 *    a no-op and the container keeps schema defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-token has
 *    EMISSIONS_ENABLED: ${EMISSIONS_ENABLED:-true}
 *    EMISSIONS_EPOCH_MS: ${EMISSIONS_EPOCH_MS:-86400000}   (owner-present 1 day, 2026-10-14)
 *    EMISSIONS_AUTO_TICK: ${EMISSIONS_AUTO_TICK:-false}
 *    EMISSIONS_TICK_MS: ${EMISSIONS_TICK_MS:-}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-token block only)
 * 6. RED: pin fails if any unique key drops, AUTO_TICK default flips true,
 *    or YIELD_DISTRIBUTION_CRON_HOURS is invented on this block
 * 7. Collision: other compose PRs — this pin only reads svc-token
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const ENV_TS = resolve(import.meta.dirname, './env.ts');

function tokenServiceBlock(source: string): string {
  const match = source.match(/^  svc-token:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-token service block missing from docker-compose.apps.yml');
  return match[0];
}

const ENABLED = /EMISSIONS_ENABLED:\s*\$\{EMISSIONS_ENABLED:-true\}/;
const AUTO_TICK = /EMISSIONS_AUTO_TICK:\s*\$\{EMISSIONS_AUTO_TICK:-false\}/;
const EPOCH_MS = /EMISSIONS_EPOCH_MS:\s*\$\{EMISSIONS_EPOCH_MS:-86400000\}/;
const TICK_MS = /EMISSIONS_TICK_MS:\s*\$\{EMISSIONS_TICK_MS:-\}/;

describe('compose emissions kill and auto-tick for svc-token', () => {
  const block = tokenServiceBlock(readFileSync(COMPOSE, 'utf8'));
  const envTs = readFileSync(ENV_TS, 'utf8');

  it('env.ts still declares the flags this pin tracks', () => {
    expect(envTs).toMatch(/EMISSIONS_ENABLED:\s*z/);
    expect(envTs).toMatch(/EMISSIONS_AUTO_TICK:\s*z/);
    expect(envTs).toMatch(/EMISSIONS_TICK_MS:\s*z/);
    expect(envTs).toMatch(/EMISSIONS_EPOCH_MS:/);
    // Owner-present 1 day (Nitro, 2026-10-14) is the ONLY emission magnitude defaulted here.
    const epochFrom = envTs.indexOf('EMISSIONS_EPOCH_MS:');
    expect(envTs.slice(epochFrom, envTs.indexOf('EMISSIONS_TICK_MS:', epochFrom))).toMatch(/\.default\(\s*86_400_000\s*\)/);
    expect(envTs).toMatch(/YIELD_JOB_ENABLED:\s*z/);
    expect(envTs).toMatch(/BUYBACK_JOB_ENABLED:\s*z/);
    const autoSlice = envTs.slice(envTs.indexOf('EMISSIONS_AUTO_TICK:'));
    expect(autoSlice.slice(0, 400)).toMatch(/\.default\(\s*false\s*\)/);
    const yieldSlice = envTs.slice(envTs.indexOf('YIELD_JOB_ENABLED:'));
    expect(yieldSlice.slice(0, 400)).toMatch(/\.default\(\s*false\s*\)/);
    const buybackSlice = envTs.slice(envTs.indexOf('BUYBACK_JOB_ENABLED:'));
    expect(buybackSlice.slice(0, 400)).toMatch(/\.default\(\s*false\s*\)/);
    const tickFrom = envTs.indexOf('EMISSIONS_TICK_MS:');
    const tickSlice = envTs.slice(tickFrom, envTs.indexOf('YIELD_JOB_ENABLED:', tickFrom));
    expect(tickSlice).not.toMatch(/\.default\(/);
    const hoursFrom = envTs.indexOf('YIELD_DISTRIBUTION_CRON_HOURS:');
    const hoursSlice = envTs.slice(hoursFrom, envTs.indexOf('BUYBACK_JOB_ENABLED:', hoursFrom));
    expect(hoursSlice).not.toMatch(/\.default\(/);
  });

  it('wires unique host pass-through keys (auto-tick default false)', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-token/);
    expect(block).toMatch(ENABLED);
    expect(block).toMatch(AUTO_TICK);
    expect(block).toMatch(TICK_MS);
    expect(block).toMatch(EPOCH_MS);
    expect(block.match(/^\s+EMISSIONS_EPOCH_MS:\s*\$\{EMISSIONS_EPOCH_MS:-86400000\}\s*$/gm)).toHaveLength(1);
    expect(block.match(/^\s+EMISSIONS_ENABLED:\s*\$\{EMISSIONS_ENABLED:-true\}\s*$/gm)).toHaveLength(1);
    expect(block.match(/^\s+EMISSIONS_AUTO_TICK:\s*\$\{EMISSIONS_AUTO_TICK:-false\}\s*$/gm)).toHaveLength(1);
    expect(block.match(/^\s+EMISSIONS_TICK_MS:\s*\$\{EMISSIONS_TICK_MS:-\}\s*$/gm)).toHaveLength(1);
    expect(block).not.toMatch(/EMISSIONS_TICK_MS:\s*\$\{EMISSIONS_TICK_MS:-86400000\}/);
    expect(block).not.toMatch(/EMISSIONS_AUTO_TICK:\s*\$\{EMISSIONS_AUTO_TICK:-true\}/);
  });

  it('does not open yield cron or invent a curve on the compose block', () => {
    expect(block).toMatch(/YIELD_JOB_ENABLED:\s*\$\{YIELD_JOB_ENABLED:-false\}/);
    expect(block).not.toMatch(/YIELD_JOB_ENABLED:\s*\$\{YIELD_JOB_ENABLED:-true\}/);
    expect(block).toMatch(/BUYBACK_JOB_ENABLED:\s*\$\{BUYBACK_JOB_ENABLED:-false\}/);
    expect(block).not.toMatch(/BUYBACK_JOB_ENABLED:\s*\$\{BUYBACK_JOB_ENABLED:-true\}/);
    expect(block).toMatch(/TRADE_URL:\s*http:\/\/svc-trade:4004/);
    expect(block).not.toMatch(/^\s+YIELD_DISTRIBUTION_CRON_HOURS:/m);
    expect(block).not.toMatch(/HALVING/i);
    expect(block).not.toMatch(/MINTER_ADDRESS/i);
  });
});
