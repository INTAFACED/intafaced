import { describe, expect, it } from 'vitest';
import { readPoolConnection, readProbeTarget } from './connection.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const published = {
  MINING_POOL_HOST: 'pool.test',
  MINING_POOL_PORT: '3999',
  MINING_POOL_SECURE_URL: 'stratum+ssl://pool.test:3999',
  MINING_WORKER_NAME_PATTERN: 'TEST.{worker}',
};

describe('pool connection', () => {
  it('returns the stored lines and the signed account id, and no secret', () => {
    const connection = readPoolConnection(published, ALICE);
    expect(connection).toEqual({
      host: 'pool.test',
      port: '3999',
      secureUrl: 'stratum+ssl://pool.test:3999',
      accountId: ALICE,
      workerNamePattern: 'TEST.{worker}',
    });
    // The miner secret is issued on its own procedure and shown once; the connection read never carries it.
    expect(connection).not.toHaveProperty('password');
    expect(connection).not.toHaveProperty('secret');
    expect(readPoolConnection({ ...published, MINING_ACCOUNT_ID: BOB }, ALICE).accountId).toBe(ALICE);
    expect(readPoolConnection(published, BOB).accountId).toBe(BOB);
  });

  it('a blank host or port refuses and does not invent a port', () => {
    for (const env of [
      { MINING_POOL_PORT: '3999' },
      { MINING_POOL_HOST: 'pool.test' },
      { MINING_POOL_HOST: '  ', MINING_POOL_PORT: '3999' },
      { MINING_POOL_HOST: 'pool.test', MINING_POOL_PORT: '' },
    ]) {
      expect(() => readPoolConnection(env, ALICE)).toThrowError(expect.objectContaining({ code: 'mining.connection_unset' }));
    }
    expect(() => readPoolConnection({ MINING_POOL_HOST: 'pool.test' }, ALICE)).toThrowError(
      expect.objectContaining({ code: 'mining.connection_unset' }),
    );
    try {
      readProbeTarget({ MINING_POOL_HOST: 'pool.test' });
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain('3336');
    }
  });

  it('an unpublished secure URL or worker pattern is omitted, and a bad host is not dialled as a URL', () => {
    const connection = readPoolConnection({ MINING_POOL_HOST: 'pool.test', MINING_POOL_PORT: '3999' }, ALICE);
    expect(connection.secureUrl).toBeNull();
    expect(connection.workerNamePattern).toBeNull();
    for (const host of ['http://pool.test', 'pool.test:3999', 'user@pool.test', 'a b']) {
      expect(() => readPoolConnection({ MINING_POOL_HOST: host, MINING_POOL_PORT: '3999' }, ALICE)).toThrowError(
        expect.objectContaining({ code: 'mining.connection_unset' }),
      );
    }
  });

  it('rejects a leading-zero port, a port past 65535, and a blank account id', () => {
    expect(() => readPoolConnection({ MINING_POOL_HOST: 'pool.test', MINING_POOL_PORT: '03336' }, ALICE)).toThrowError(
      expect.objectContaining({ code: 'mining.connection_unset' }),
    );
    expect(() => readPoolConnection({ MINING_POOL_HOST: 'pool.test', MINING_POOL_PORT: '65536' }, ALICE)).toThrowError(
      expect.objectContaining({ code: 'mining.connection_unset' }),
    );
    expect(() => readPoolConnection(published, '   ')).toThrowError(expect.objectContaining({ code: 'mining.connection_unset' }));
  });
});
