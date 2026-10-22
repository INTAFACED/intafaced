import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createLedgerRouter } from '../router.js';
import type { LedgerService } from '../service.js';
import { TraceInconsistentError, traceBusinessKey } from './operator-trace.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const authConfig = {
  secret: 'a-ledger-trace-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

async function ctx(scopes: string[], mfa: boolean): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: USER, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes, tier: 'basic', mfa },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

/** TEST amounts only. */
async function seeded() {
  const ledger = new MemoryLedger();
  const deposit = recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10.5'), rail: 'test', railRef: 'trace-1' });
  const tx = await ledger.post(deposit);
  return { ledger, deposit, tx };
}

describe('traceBusinessKey', () => {
  it('traces a booked key to its transaction, every posting as decimal strings', async () => {
    const { ledger, deposit, tx } = await seeded();
    const out = await traceBusinessKey(ledger, { businessKey: deposit.idempotencyKey });
    expect(out).toMatchObject({ found: true, txId: tx.id, module: deposit.module, reason: deposit.reason, hash: tx.hash });
    if (!out.found) throw new Error('expected found');
    expect(out.postings).toHaveLength(tx.entries.length);
    for (const p of out.postings) {
      expect(typeof p.amount).toBe('string');
      expect(typeof p.balanceAfter).toBe('string');
    }
    expect(out.postings.map((p) => p.amount)).toContain('10.5');
  });

  it('answers an honest no-record for a key that never booked', async () => {
    const { ledger } = await seeded();
    await expect(traceBusinessKey(ledger, { businessKey: 'never:booked:1' })).resolves.toEqual({
      found: false,
      businessKey: 'never:booked:1',
    });
  });

  it('refuses a blank key instead of treating it as absent', async () => {
    const { ledger } = await seeded();
    await expect(traceBusinessKey(ledger, { businessKey: '   ' })).rejects.toThrow();
  });

  it('refuses to show a transaction the book says was booked under another key', async () => {
    const { tx } = await seeded();
    const lying = { getTxByKey: async () => tx };
    await expect(traceBusinessKey(lying, { businessKey: 'other:key' })).rejects.toBeInstanceOf(TraceInconsistentError);
  });

  it('surfaces a ledger read failure rather than a partial answer', async () => {
    const failing = { getTxByKey: async () => Promise.reject(new Error('db down')) };
    await expect(traceBusinessKey(failing, { businessKey: 'k' })).rejects.toThrow('db down');
  });
});

describe('ledger.trace procedure', () => {
  it('serves an admin:treasury session with a second factor', async () => {
    const { ledger, deposit } = await seeded();
    const caller = createLedgerRouter(ledger as unknown as LedgerService).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.trace({ businessKey: deposit.idempotencyKey })).resolves.toMatchObject({ found: true });
  });

  it('refuses treasury scope without a second factor, a plain ledger reader, and an anonymous caller', async () => {
    const { ledger, deposit } = await seeded();
    const router = createLedgerRouter(ledger as unknown as LedgerService);
    await expect(
      router.createCaller(await ctx(['admin:treasury'], false)).trace({ businessKey: deposit.idempotencyKey }),
    ).rejects.toThrow();
    await expect(router.createCaller(await ctx(['ledger:read'], true)).trace({ businessKey: deposit.idempotencyKey })).rejects.toThrow();
    const anon: Context = { principal: null, service: 'svc-trade', region: 'DE', requestId: 'r' };
    await expect(router.createCaller(anon).trace({ businessKey: deposit.idempotencyKey })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('maps an inconsistent book to a typed internal error', async () => {
    const { tx } = await seeded();
    const lying = { getTxByKey: async () => tx } as unknown as LedgerService;
    const caller = createLedgerRouter(lying).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.trace({ businessKey: 'other:key' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'ledger.trace_inconsistent',
    });
  });

  it('still reads while the posting freeze is on', async () => {
    const { ledger, deposit } = await seeded();
    const frozen = {
      getTxByKey: (k: string) => ledger.getTxByKey(k),
      status: async () => ({ postingEnabled: false, frozenReason: 'TEST', frozenBy: 'op' }),
    };
    const caller = createLedgerRouter(frozen as unknown as LedgerService).createCaller(await ctx(['admin:treasury'], true));
    await expect(caller.trace({ businessKey: deposit.idempotencyKey })).resolves.toMatchObject({ found: true });
  });
});
