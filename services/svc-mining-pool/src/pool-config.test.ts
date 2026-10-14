/**
 * Unit card: svc-mining-pool database pool size is owner-published.
 * No DATABASE_URL means no database. A DATABASE_URL with an unset, blank or
 * illegal DATABASE_POOL_MAX refuses boot (never an invented 8 or 10).
 * server.ts reads it only through the shared loader.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EnvError } from '@intafaced/config';
import { loadMiningPoolDatabase } from './pool-config.js';

const URL_OK = 'postgres://svc_mining_pool:svc_mining_pool@postgres:5432/intafaced';

describe('svc-mining-pool DATABASE_POOL_MAX refuse-closed', () => {
  it('no DATABASE_URL means no database, whatever the pool size says', () => {
    expect(loadMiningPoolDatabase({})).toBeNull();
    expect(loadMiningPoolDatabase({ DATABASE_URL: '  ', DATABASE_POOL_MAX: '4' })).toBeNull();
  });

  it('refuses when DATABASE_POOL_MAX is unset', () => {
    expect(() => loadMiningPoolDatabase({ DATABASE_URL: URL_OK })).toThrow(EnvError);
  });

  it.each(['', '   ', '0', '-1', '1.5', 'many', '201'])('refuses DATABASE_POOL_MAX=%j', (value) => {
    try {
      loadMiningPoolDatabase({ DATABASE_URL: URL_OK, DATABASE_POOL_MAX: value });
      expect.unreachable('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).issues.some((i) => i.startsWith('DATABASE_POOL_MAX'))).toBe(true);
    }
  });

  it('uses exactly the owner-published size', () => {
    expect(loadMiningPoolDatabase({ DATABASE_URL: URL_OK, DATABASE_POOL_MAX: '3' })).toEqual({ url: URL_OK, max: 3, ssl: false });
    expect(loadMiningPoolDatabase({ DATABASE_URL: URL_OK, DATABASE_POOL_MAX: '12', DATABASE_SSL: 'true' })?.ssl).toBe(true);
  });

  it('server.ts has no hard-coded pool size and goes through the shared loader', () => {
    const serverSrc = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    expect(serverSrc).not.toMatch(/max:\s*\d/);
    expect(serverSrc).toContain('loadMiningPoolDatabase');
    expect(serverSrc).not.toMatch(/process\.env\.DATABASE_(URL|POOL_MAX)/);
    expect(readFileSync(new URL('./pool-config.ts', import.meta.url), 'utf8')).toContain('postgresEnvSchema');
  });

  it('compose wires the database and leaves the payout interval unset', () => {
    const compose = readFileSync(new URL('../../../docker-compose.apps.yml', import.meta.url), 'utf8');
    const start = compose.indexOf('\n  svc-mining-pool:');
    const block = compose.slice(start, compose.indexOf('\n\n', start));
    expect(block).toMatch(/DATABASE_URL: postgres:\/\/svc_mining_pool:/);
    expect(block).toMatch(/depends_on:\s*\n\s*<<: \*needs-schema/);
    expect(block).not.toMatch(/^\s+MINING_PAYOUT_INTERVAL_MS:/m);
  });
});
