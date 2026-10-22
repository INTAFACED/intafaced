import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { MemoryEventBus } from '@intafaced/events';
import { LedgerError, parseAmount, recipes } from '@intafaced/ledger-client';
import { httpError } from '../s2s-http.js';
import { LedgerService } from '../service.js';
import { WRITES_BLOCKED_STORE_DISK_FULL, WRITES_BLOCKED_STORE_UNAVAILABLE, classifyWriteBlock, toWriteBlockError } from './write-block.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('classifyWriteBlock', () => {
  it('names a full disk', () => {
    expect(classifyWriteBlock(pgError('53100'))).toBe(WRITES_BLOCKED_STORE_DISK_FULL);
  });

  it.each([['08006'], ['08001'], ['57P01'], ['25006'], ['ECONNREFUSED'], ['CONNECTION_CLOSED'], ['CONNECT_TIMEOUT']])(
    'names an unavailable store for %s',
    (code) => {
      expect(classifyWriteBlock(pgError(code))).toBe(WRITES_BLOCKED_STORE_UNAVAILABLE);
    },
  );

  it('leaves everything else alone: ledger refusals, constraint errors, non-errors', () => {
    expect(classifyWriteBlock(new LedgerError('frozen', 'ledger.frozen'))).toBeNull();
    expect(classifyWriteBlock(pgError('23505'))).toBeNull();
    expect(classifyWriteBlock(pgError('53200'))).toBeNull();
    expect(classifyWriteBlock(new Error('no code'))).toBeNull();
    expect(classifyWriteBlock(null)).toBeNull();
    expect(classifyWriteBlock('53100')).toBeNull();
  });

  it('wraps a store error as a typed LedgerError and passes other errors through unchanged', () => {
    const wrapped = toWriteBlockError(pgError('53100'));
    expect(wrapped).toBeInstanceOf(LedgerError);
    expect(wrapped).toMatchObject({ code: WRITES_BLOCKED_STORE_DISK_FULL });
    const other = pgError('23505');
    expect(toWriteBlockError(other)).toBe(other);
  });

  it('maps to 503 on the service door, so callers retry with the same key', () => {
    expect(httpError(toWriteBlockError(pgError('08006')))).toEqual({
      status: 503,
      body: { message: WRITES_BLOCKED_STORE_UNAVAILABLE, code: WRITES_BLOCKED_STORE_UNAVAILABLE },
    });
  });
});

describe('LedgerService.post against a store that is down', () => {
  it('refuses with ledger.writes_blocked_store_unavailable, not an untyped error', async () => {
    // Port 1 on loopback: nothing listens, so the connection is refused before anything could be booked.
    const sql = postgres('postgres://nobody:nobody@127.0.0.1:1/none_test', { max: 1, connect_timeout: 2, onnotice: () => undefined });
    const service = new LedgerService(sql, new MemoryEventBus());
    const deposit = recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('1'), rail: 'test', railRef: 'write-block-1' });
    try {
      await expect(service.post(deposit)).rejects.toMatchObject({ code: WRITES_BLOCKED_STORE_UNAVAILABLE });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
